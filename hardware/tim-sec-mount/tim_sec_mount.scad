// One-piece tool mount for the Lexium Cobot LXMRL03 (JAKA Zu 3 flange): a SICK TiM5xx/7xx 2D LiDAR and a SICK
// sensingCam SEC110 on the same printed part.
//
// Coordinates = the cobot's flange frame: the flange face is Z 0 and +Z points away from the arm (towards the belt).
// That is also the print orientation: the flange face lies on the bed, so print layers are Z slices.
//
// The TiM lies on its side: its hood axis runs along +X (the direction of travel), its front (the 90° beam) points
// down at the belt and its connectors point up at the arm. Its scan plane is the flange's Y-Z plane (X 0), so the
// fan stands across the belt and its 90° blind sector (around the connectors) faces the arm.
// The SEC110 sits under the +X end of the plate on a solid block, looking down, tilted back towards the scan line.
//
// How each sensor is held (no part relies on friction alone):
//   TiM     box cradle: side walls (±Y), base posts (-X), ledges under its front face at the base end (+Z),
//           back pads (-Z); 2 x M3 screws into its own side threads (SICK's mounting points); 4 nylon-tipped set
//           screws against rattle; a strap slot for a cable tie or hook-and-loop strap round its body.
//   SEC110  seat with a locating rim on three sides; 2 x M4 screws into its back from the top of the plate.
//
// Sources (read from the documents, Nov 2026):
//   Flange: Schneider Hardware Guide EIO0000004783, p.41-42: 4 x M6 on Ø50, 7 mm deep; pin hole Ø6 H7 on Ø50 at 45°
//           between two bolts; centring spigot Ø63 (5.5 high), recess Ø31.5.
//   TiM:    SICK datasheets TiM571-2050101 / TiM781-2174101 p.5: body 60 x 61 x 85.75 mm, 250 g, light emission
//           62.46 mm above the base, swivel connector unit at the back, 15.4 mm past the base and 17.4 mm behind
//           the back; one M3 thread (2.8 deep, max 0.8 Nm) on each side face, 24.4 above the base, 33 from the back.
//   SEC110: SICK datasheet SEC110-5C9D1SFZZZZ p.5: 57.5 x 49 x 33.6 mm, 120 g; back: 2 x M4 30 mm apart, 12 mm
//           from the bottom edge; two M12 connectors 22.4 mm apart, 33.9 mm from the bottom edge, 10.2 mm proud.
//
// Render one part:  openscad --backend=manifold -D 'part="mount"' -o stl/mount.stl tim_sec_mount.scad
// part = "assembly" (preview), "mount", "fit_test", or a check_* part (each must come out empty)

part = "assembly";

/* [Print] */
clr = 0.4;          // clearance around the sensors (per side)
$fn = 64;

/* [Flange: LXMRL03] */
fl_pcd   = 50;      // bolt circle
fl_bolt  = 6.6;     // M6 clearance
fl_wash  = 19;      // counterbore for an M6 DIN 9021 washer (Ø18) under the socket head
fl_pin   = 6.1;     // Ø6 dowel (print undersize, ream or press)
fl_d     = 68;      // flange body diameter (dummy only)
pt       = 12;      // plate thickness
cb_depth = 4;       // washer counterbore depth: 8 mm of plate under the washer (M6 x 16: 6.4 mm into the 7 mm thread)

/* [TiM5xx/7xx] */
tim_w = 60; tim_d = 61; tim_h = 85.75;
tim_scan = 62.46;           // scan plane above the base
tim_hood = 27.3;            // hood length (the optical head), at the top end
tim_conn_below = 15.37;     // connector unit below the base (101.12 - 85.75)
tim_conn_behind = 17.37;    // connector unit behind the back face
tim_conn_from_back = 14.3;  // connector unit reaches this far into the body from the back (61 - 46.71)
tim_hole = [24.4, 33];      // the M3 thread on each side face: height above the base, distance from the back
gap = 20;                   // plate underside to TiM back face: room for the connector unit (17.4)
cradle_len = 46;            // how far along the TiM body the side walls reach (its hood starts at 58.5)
wall = 6;                   // cradle wall thickness
ledge = 6;                  // ledges under the TiM front face at the base end, along X
ledge_y = 22;               // ledges run from |Y| 22 to the wall (the connector unit is |Y| < 18)
slide = 8;                  // the TiM goes in this far towards +X, then slides back onto the ledges
fillet = 10;                // 45° fillets between the plate and the walls (inside)

/* [SEC110] */
cam_w = 57.5; cam_h = 49; cam_d = 33.6;
cam_x = 68;         // camera centre along X: the TiM's hood clears it while the TiM goes in
cam_drop = 34;      // plate underside to the camera's back face (plug channel and screw length)
cam_tilt = 15;      // degrees, looking back towards the scan line (X 0)
cam_rim = 1.5;      // locating rim round the camera's back, on 3 sides
cam_under = 5;      // plastic under the M4 screw heads (M4 x 8 = 3 mm into the camera)

fan_r = 140;        // laser fan drawn in the assembly view, mm

/* [Derived] */
tim_back_z  = pt + gap;                 // TiM back face (connector side)
tim_front_z = tim_back_z + tim_d;       // TiM front face (towards the belt)
tim_base_x  = -tim_scan;                // TiM base; hood top at tim_h - tim_scan
optical_z   = tim_back_z + tim_d / 2;   // scan origin: hood axis, mid-depth
y_in = tim_w / 2 + clr;                 // inside face of the side walls
x0 = tim_base_x - clr - wall;           // outside of the base posts
x1 = tim_base_x + cradle_len;           // +X end of the side walls
z_bot = tim_front_z + clr + 5;          // bottom of the walls and ledges
plate_x0 = x0;
plate_x1 = cam_x + cam_h / 2 + 3;
plate_y = y_in + wall;

echo(str("TiM scan origin (tool TCP): X 0, Y 0, Z ", optical_z, " mm from the flange face"));

module rrect(xa, xb, y, r, h) {
  hull() for (x = [xa + r, xb - r], s = [-1, 1]) translate([x, s * (y - r), 0]) cylinder(r = r, h = h);
}
module cam_place() {   // camera frame: X along its 49 mm side (connectors towards +X), Z 0 = its back, +Z = lens
  translate([cam_x, 0, pt + cam_drop]) rotate([0, -cam_tilt, 0]) children();
}

// ------------------------------------------------------------------ the mount (one piece)
module mount() {
  difference() {
    union() {
      rrect(plate_x0, plate_x1, plate_y, 6, pt);
      cradle();
      camera_block();
    }
    flange_holes();
    cradle_cuts();
    camera_cuts();
  }
}

module flange_holes() {
  for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, 0]) {
    translate([0, 0, -1]) cylinder(d = fl_bolt, h = pt + 2);
    translate([0, 0, pt - cb_depth]) cylinder(d = fl_wash, h = 40);   // washer + head, open below for the hex key
  }
  rotate(45) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_pin, h = 8);   // blind: 7 mm of the dowel in the plate
}

module cradle() {
  // side walls, the full depth of the TiM
  for (s = [-1, 1]) translate([x0, s > 0 ? y_in : -y_in - wall, pt - 1]) cube([x1 - x0, wall, z_bot - pt + 1]);
  // base posts either side of the connector unit
  for (s = [-1, 1]) translate([x0, s > 0 ? ledge_y + 1 : -y_in, pt - 1]) cube([wall, y_in - ledge_y - 1, z_bot - pt + 1]);
  // ledges under the TiM's front face at the base end
  for (s = [-1, 1]) translate([x0, s > 0 ? ledge_y : -y_in, tim_front_z + clr]) cube([wall + clr + ledge, y_in - ledge_y, z_bot - tim_front_z - clr]);
  // back pads: the TiM's back face rests on them (beyond the connector unit, which ends 10 mm past the base)
  for (s = [-1, 1]) translate([-32, s > 0 ? 12 : -y_in, pt - 1]) cube([x1 + 32, y_in - 12, tim_back_z - clr - pt + 1]);
  // 45° fillets between the plate and the side walls, inside
  for (s = [-1, 1]) hull() {
    translate([x0, s > 0 ? y_in - fillet : -y_in, pt - 0.01]) cube([x1 - x0, fillet, 0.01]);
    translate([x0, s > 0 ? y_in - 0.01 : -y_in, pt]) cube([x1 - x0, 0.01, fillet]);
  }
  // fins continuing the walls towards the hood, tapering into the plate (inside the TiM's blind sector)
  for (s = [-1, 1]) hull() {
    translate([x1 - 1, s > 0 ? y_in : -y_in - wall, pt - 1]) cube([1, wall, gap - 2]);
    translate([-8, s > 0 ? y_in : -y_in - wall, pt - 1]) cube([1, wall, 1]);
  }
}

module cradle_cuts() {
  // connector window between the base posts, open to the bottom (the connector unit and its plugs pass through)
  translate([x0 - 1, -ledge_y - 1, pt]) cube([wall + clr + 2, 2 * ledge_y + 2, 200]);
  // M3 screws into the TiM's own side threads: Ø3.4 through the wall, Ø6.5 head counterbore 3 deep from outside
  for (s = [-1, 1]) translate([tim_base_x + tim_hole[0], s * (y_in + wall / 2), tim_back_z + tim_hole[1]]) rotate([90, 0, 0]) {
    cylinder(d = 3.4, h = wall + 2, center = true);
    translate([0, 0, -s * (wall / 2 - 1.5)]) cylinder(d = 6.5, h = 3.01, center = true);
  }
  // M3 heat-set inserts (Ø4.0) for nylon-tipped set screws against rattle
  for (s = [-1, 1], x = [tim_base_x + 10, tim_base_x + 40])
    translate([x, s * (y_in + wall / 2), optical_z]) rotate([90, 0, 0]) cylinder(d = 4.0, h = wall + 2, center = true);
  // strap: a 9 x 3 slot through both walls and pads, just above the TiM's back, and notches under the walls so
  // the strap lies flat on the TiM's front face
  translate([-30.5, -y_in - wall - 1, pt + 4]) cube([9, 2 * (y_in + wall) + 2, 3]);
  for (s = [-1, 1]) translate([-30.5, s > 0 ? y_in - 1 : -y_in - wall - 1, tim_front_z - 2]) cube([9, wall + 2, 20]);
}

// ------------------------------------------------------------------ camera block
module camera_block() {
  hull() {
    translate([plate_x1 - 0.01 - (plate_x1 - 36), -cam_w / 2 - 6, pt - 0.01]) cube([plate_x1 - 36, cam_w + 12, 0.01]);
    cam_place() translate([-cam_h / 2 - 2.3, -cam_w / 2 - 6, -0.01]) cube([cam_h + 2.3, cam_w + 12, 0.01]);   // includes the rim
  }
  // locating rim round the camera's back on three sides (open at +X, the connector end)
  cam_place() difference() {
    translate([-cam_h / 2 - 2.3, -cam_w / 2 - 2.3, -0.01]) cube([cam_h + 2.3, cam_w + 4.6, cam_rim + 0.01]);
    translate([-cam_h / 2 - 0.3, -cam_w / 2 - 0.3, -1]) cube([cam_h + 10, cam_w + 0.6, cam_rim + 2]);
  }
}

module camera_cuts() {
  cam_place() {
    // M4 screws into the camera's back (30 mm apart, 12 mm from its bottom edge), driven from the top of the plate
    for (s = [-1, 1]) translate([12 - cam_h / 2, s * 15, 0]) {
      translate([0, 0, -cam_under - 1]) cylinder(d = 4.4, h = cam_under + 2);
      translate([0, 0, -100 - cam_under]) cylinder(d = 8.5, h = 100);
    }
    // channel for the two straight M12 plugs (22.4 apart, 33.9 from the bottom edge): open to the top and the +X end
    translate([33.9 - cam_h / 2 - 10, -21, -100]) cube([60, 42, 100.5]);
  }
}

// ------------------------------------------------------------------ fit test: print this first (about 25 min)
// The flange bolt pattern and dowel hole, one washer counterbore, an M3 insert hole, the TiM screw hole and
// counterbore, an M4 camera screw hole and counterbore, and the TiM width between two walls. One piece.
module fit_test() {
  difference() {
    union() {
      cylinder(d = 64, h = 5);
      translate([-10, 29, 0]) cube([20, 8, 5]);
      translate([-y_in - wall, 36, 0]) cube([2 * (y_in + wall), 14, 5]);
      for (s = [-1, 1]) translate([s > 0 ? y_in : -y_in - wall, 36, 0]) cube([wall, 14, 12]);
    }
    for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_bolt, h = 10);
    translate([fl_pcd / 2, 0, 3]) cylinder(d = fl_wash, h = 10);              // washer counterbore (bolt at +X)
    rotate(45) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_pin, h = 10);
    translate([0, 0, -1]) cylinder(d = 32, h = 10);                           // see the arm's centring recess
    translate([-12, 22, -1]) cylinder(d = 4.0, h = 10);                       // M3 insert
    translate([12, 22, -1]) { cylinder(d = 3.4, h = 10); translate([0, 0, 2]) cylinder(d = 6.5, h = 10); }   // TiM M3
    translate([-12, -22, -1]) { cylinder(d = 4.4, h = 10); translate([0, 0, 3]) cylinder(d = 8.5, h = 10); }  // camera M4
  }
}

// ------------------------------------------------------------------ dummies for the assembly view
module tim_solid() {   // body, hood and connector unit, without the clearance
  translate([tim_base_x, -tim_w / 2, tim_back_z]) cube([tim_h - tim_hood, tim_w, tim_d]);
  translate([tim_base_x + tim_h - tim_hood, 0, optical_z]) rotate([0, 90, 0]) cylinder(d = 50, h = tim_hood);
  translate([tim_base_x - tim_conn_below, -18, tim_back_z - tim_conn_behind]) cube([tim_conn_below + 10, 36, tim_conn_behind + tim_conn_from_back]);
}
module tim_plugs() {   // straight M12 plugs out of the connector unit, along -X (about 50 mm with the cable bend)
  for (s = [-1, 1]) translate([tim_base_x - tim_conn_below, s * 9, tim_back_z - 6]) rotate([0, -90, 0]) cylinder(d = 16, h = 50);
}
module tim_dummy() {
  color("DimGray") translate([tim_base_x, -tim_w / 2, tim_back_z]) cube([tim_h - tim_hood, tim_w, tim_d]);
  color("Gold", .8) translate([tim_base_x + tim_h - tim_hood, 0, optical_z]) rotate([0, 90, 0]) cylinder(d = 50, h = tim_hood);
  color("Black") translate([tim_base_x - tim_conn_below, -18, tim_back_z - tim_conn_behind]) cube([tim_conn_below + 10, 36, tim_conn_behind + tim_conn_from_back]);
  color("Red", .25) translate([0, 0, optical_z]) rotate([0, 90, 0]) linear_extrude(0.5) polygon([[0, 0], for (a = [-45:5:225]) fan_r * [-sin(a), cos(a)]]);   // 90° = straight down, blind sector up
}
// camera body + straight M12 plugs going up from its back (55 mm: connector 10.2 + plug and cable bend)
module cam_solid(body = true, plugs = true, gap = 0.1) {
  cam_place() {
    if (body) translate([-cam_h / 2, -cam_w / 2, gap]) cube([cam_h, cam_w, cam_d]);
    if (plugs) for (s = [-1, 1]) translate([33.9 - cam_h / 2, s * 11.2, -55]) cylinder(d = 16, h = 55);
  }
}
module cam_dummy() {
  cam_place() {
    color("SteelBlue") translate([-cam_h / 2, -cam_w / 2, 0]) cube([cam_h, cam_w, cam_d]);
    color("Black") for (s = [-1, 1]) translate([33.9 - cam_h / 2, s * 11.2, -55]) cylinder(d = 15, h = 55);
  }
}
module flange_dummy() { color("Silver") translate([0, 0, -30]) cylinder(d = fl_d, h = 30); }
// the TiM's 270° fan (not its 90° blind sector, which faces the arm), 1 mm thick, 500 mm out
module fan_solid() {
  translate([-0.5, 0, optical_z]) rotate([0, 90, 0]) linear_extrude(1) polygon([[0, 0], for (a = [-45:5:225]) 500 * [-sin(a), cos(a)]]);
}
// the space the TiM sweeps going in: up from below, `slide` mm towards +X of its seat, then back along -X onto the ledges
module tim_insert_path() {
  // each piece is convex, so a hull of two positions of it is exactly its swept volume
  for (piece = [0, 1, 2]) {
    hull() { translate([slide, 0, 0]) tim_piece(piece); translate([slide, 0, 300]) tim_piece(piece); }
    hull() { translate([slide, 0, 0]) tim_piece(piece); tim_piece(piece); }
  }
}
module tim_piece(i) {
  if (i == 0) translate([tim_base_x, -tim_w / 2, tim_back_z]) cube([tim_h - tim_hood, tim_w, tim_d]);
  if (i == 1) translate([tim_base_x + tim_h - tim_hood, 0, optical_z]) rotate([0, 90, 0]) cylinder(d = 50, h = tim_hood);
  if (i == 2) translate([tim_base_x - tim_conn_below, -18, tim_back_z - tim_conn_behind]) cube([tim_conn_below + 10, 36, tim_conn_behind + tim_conn_from_back]);
}

// ------------------------------------------------------------------ collision checks: each must render EMPTY
if (part == "check_tim") intersection() { mount(); union() { tim_solid(); tim_plugs(); } }
else if (part == "check_cam_body") intersection() { mount(); cam_solid(plugs = false); }
else if (part == "check_cam_plugs") intersection() { mount(); cam_solid(body = false); }
else if (part == "check_cam_tim") intersection() { cam_solid(); union() { tim_solid(); tim_plugs(); } }
else if (part == "check_fan") intersection() { union() { mount(); cam_solid(); } fan_solid(); }
else if (part == "check_insert") intersection() { mount(); tim_insert_path(); }
else if (part == "check_insert_cam") intersection() { cam_solid(); tim_insert_path(); }
else if (part == "mount") mount();
else if (part == "fit_test") fit_test();
// assembly view: turned so the arm is up and the belt is down
else rotate([180, 0, 0]) { color("Orange") mount(); tim_dummy(); cam_dummy(); flange_dummy(); }
