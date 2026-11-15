// One-piece tool mount for the Lexium Cobot LXMRL03 (JAKA Zu 3 flange): a SICK TiM240 2D LiDAR and a SICK
// sensingCam SEC110 on the same printed part.
//
// Coordinates = the cobot's flange frame: the flange face is Z 0 and +Z points away from the arm (towards the belt).
// That is also the print orientation: the flange face lies on the bed, so print layers are Z slices.
//
// The TiM lies on its side: its base faces -X and its hood +X (the direction of travel), its front (the 0° beam)
// points down at the belt and its connectors (at the back, next to the base) point up at the arm. Its scan plane is
// parallel to its base, here the flange's Y-Z plane (X 0), so the 240° fan stands across the belt and its 120° blind
// sector (around the connectors) faces the arm. The M12 plugs come straight out of the back, up through a window in
// the plate, beside the flange.
// The SEC110 sits under the +X end of the plate on a solid block, looking down, tilted back towards the scan line.
//
// How each sensor is held (no part relies on friction alone):
//   TiM     2 x M3 screws through the base wall into the two threads in its base (SICK's mounting points), plus a box
//           cradle: side walls (±Y), the base wall (-X), a ledge under its front face at the base end (+Z), back
//           pads (-Z); 4 nylon-tipped set screws against rattle; a strap slot for a cable tie or hook-and-loop strap.
//   SEC110  seat with a locating rim on three sides; 2 x M4 screws into its back from the top of the plate.
//
// Sources (read from the documents, Nov 2026):
//   Flange: Schneider Hardware Guide EIO0000004783, p.41-42: 4 x M6 on Ø50, 7 mm deep; pin hole Ø6 H7 on Ø50 at 45°
//           between two bolts; centring spigot Ø63 (5.5 high), recess Ø31.5.
//   TiM240: SICK datasheet TiM240-2050300 p.4: 60 (W) x 59.5 (D) x 75.8 (H) mm, 150 g; light emission 53 mm above
//           the base; 2 x M3 in the base (2.8 deep, max 0.7 Nm), 44.4 apart, 30 mm from the back; swivel connector
//           unit at the back, flush with the base, 79.7 - 59.5 = 20.2 mm behind the back, plugs 7.8 mm above the
//           base, 20.6 apart, pointing backwards; 240° field, 0° out of the front. Read from the drawing (not
//           dimensioned): the box part of the housing is about 36 mm tall and the hood narrows above it; the scan
//           axis sits at about mid-depth.
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

/* [TiM240] */
tim_w = 60; tim_d = 59.5; tim_h = 75.8;
tim_scan = 53;              // light emission (scan plane) above the base
tim_box = 36;               // the box part of the housing above the base; the hood narrows above it (drawing, approx.)
tim_axis = 29.75;           // scan axis from the back face (mid-depth; the drawing puts the hood centre about here)
tim_conn_behind = 20.2;     // connector unit behind the back face (79.7 - 59.5)
tim_conn_h = 15;            // connector unit: from the base up to about here (drawing, approx.)
tim_conn_w = 37;            // connector unit width (drawing, approx.)
tim_plug_x = 7.8;           // M12 plug axes above the base
tim_plug_y = 20.6;          // M12 plugs apart
tim_holes = [44.4, 30];     // the two M3 threads in the base: apart, distance from the back
gap = 23;                   // plate underside to TiM back face: room for the connector unit (20.2)
cradle_len = 34;            // how far along the TiM body the side walls reach (the hood starts at about 36)
wall = 6;                   // cradle wall thickness
ledge = 6;                  // ledge under the TiM front face at the base end, along X
slide = 8;                  // the TiM goes in this far towards +X, then slides back onto the ledge
fillet = 10;                // 45° fillets between the plate and the walls (inside)
pad_y = 21;                 // back pads from |Y| 21 to the walls (the connector unit and its plugs are inside that)

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
optical_z   = tim_back_z + tim_axis;    // scan origin
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
  // base wall: the TiM's base screws to it
  translate([x0, -y_in - wall, pt - 1]) cube([wall, 2 * (y_in + wall), z_bot - pt + 1]);
  // ledge under the TiM's front face at the base end (held by the base wall and both side walls)
  translate([x0, -y_in, tim_front_z + clr]) cube([wall + clr + ledge, 2 * y_in, z_bot - tim_front_z - clr]);
  // back pads: the TiM's back face rests on them, either side of the connector unit
  for (s = [-1, 1]) translate([tim_base_x + 2, s > 0 ? pad_y : -y_in, pt - 1]) cube([x1 - tim_base_x - 2, y_in - pad_y, tim_back_z - clr - pt + 1]);
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
  // window in the plate for the two M12 plugs, which point straight up out of the TiM's back
  translate([tim_base_x - clr, -tim_plug_y / 2 - 10, -1]) cube([tim_plug_x + 9 + clr, tim_plug_y + 20, pt + 2]);   // stops at the base wall
  // M3 screws through the base wall into the TiM's base: Ø3.4, Ø6.5 head counterbore 3 deep from outside
  for (s = [-1, 1]) translate([x0 + wall / 2, s * tim_holes[0] / 2, tim_back_z + tim_holes[1]]) rotate([0, 90, 0]) {
    cylinder(d = 3.4, h = wall + 2, center = true);
    translate([0, 0, -wall / 2 + 1.5 - 0.01]) cylinder(d = 6.5, h = 3.02, center = true);
  }
  // M3 heat-set inserts (Ø4.0) for nylon-tipped set screws against rattle
  for (s = [-1, 1], x = [tim_base_x + 10, tim_base_x + 28])
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
// The flange bolt pattern and dowel hole, one washer counterbore, an M3 insert hole, an M4 camera screw hole and
// counterbore, and the TiM gauge: its width between two walls and the two base screw holes 44.4 apart (screw the
// TiM240's base onto it with M3 x 6). One piece.
module fit_test() {
  difference() {
    union() {
      cylinder(d = 72, h = 5);   // wide enough for the Ø19 washer counterbore
      translate([-10, 29, 0]) cube([20, 8, 5]);
      translate([-y_in - wall, 36, 0]) cube([2 * (y_in + wall), 14, 5]);
      for (s = [-1, 1]) translate([s > 0 ? y_in : -y_in - wall, 36, 0]) cube([wall, 14, 12]);
    }
    for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_bolt, h = 10);
    translate([fl_pcd / 2, 0, 3]) cylinder(d = fl_wash, h = 10);              // washer counterbore (bolt at +X)
    rotate(45) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_pin, h = 10);
    translate([0, 0, -1]) cylinder(d = 30, h = 10);                           // see the arm's centring recess (Ø31.5)
    translate([-12, 22, -1]) cylinder(d = 4.0, h = 10);                       // M3 insert
    for (s = [-1, 1]) translate([s * tim_holes[0] / 2, 43, -1]) { cylinder(d = 3.4, h = 10); cylinder(d = 6.5, h = 2.5); }   // TiM base M3
    translate([-12, -22, -1]) { cylinder(d = 4.4, h = 10); translate([0, 0, 3]) cylinder(d = 8.5, h = 10); }  // camera M4
  }
}

// ------------------------------------------------------------------ dummies for the assembly view
module tim_box() { translate([tim_base_x, -tim_w / 2, tim_back_z]) cube([tim_box, tim_w, tim_d]); }
module tim_hood() {   // narrows from about 50 x 58 to 40 x 48 (Y x Z), drawn a little large
  hull() {
    translate([tim_base_x + tim_box - 0.01, -25, optical_z - 29]) cube([0.01, 50, 58]);
    translate([tim_base_x + tim_h - 0.01, -20, optical_z - 24]) cube([0.01, 40, 48]);
  }
}
module tim_conn() { translate([tim_base_x, -tim_conn_w / 2, tim_back_z - tim_conn_behind]) cube([tim_conn_h, tim_conn_w, tim_conn_behind + 3]); }
module tim_solid() { tim_box(); tim_hood(); tim_conn(); }   // without the clearance
module tim_plugs() {   // straight M12 plugs out of the back of the connector unit, up through the plate (50 mm with the bend)
  for (s = [-1, 1]) translate([tim_base_x + tim_plug_x, s * tim_plug_y / 2, tim_back_z - tim_conn_behind - 50]) cylinder(d = 16, h = 50);
}
module tim_fan(r) {   // the 240° fan in the flange's Y-Z plane at X 0: TiM angle a points cos(a)·Z + sin(a)·Y
  multmatrix([[0, 0, 1, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1]]) children();
}
module tim_dummy(fan = true) {
  color("DimGray") tim_box();
  color("Gold", .8) tim_hood();
  color("Black") tim_conn();
  color("Black") tim_plugs();
  if (fan) color("Red", .25) translate([-0.25, 0, optical_z]) tim_fan() linear_extrude(0.5) polygon([[0, 0], for (a = [-120:5:120]) fan_r * [sin(a), cos(a)]]);   // 0° = straight down, blind sector up
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
// the TiM's 240° fan (not its 120° blind sector, which faces the arm), 1 mm thick, 500 mm out
module fan_solid() {
  translate([-0.5, 0, optical_z]) tim_fan() linear_extrude(1) polygon([[0, 0], for (a = [-120:5:120]) 500 * [sin(a), cos(a)]]);
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
  if (i == 0) tim_box();
  if (i == 1) tim_hood();
  if (i == 2) tim_conn();
}

// ------------------------------------------------------------------ collision checks: each must render EMPTY
if (part == "check_tim") intersection() { mount(); union() { tim_solid(); tim_plugs(); } }
else if (part == "check_tim_flange") intersection() { tim_plugs(); translate([0, 0, -200]) cylinder(d = fl_d, h = 200); }   // plugs clear the arm's flange body
else if (part == "check_cam_body") intersection() { mount(); cam_solid(plugs = false); }
else if (part == "check_cam_plugs") intersection() { mount(); cam_solid(body = false); }
else if (part == "check_cam_tim") intersection() { cam_solid(); union() { tim_solid(); tim_plugs(); } }
else if (part == "check_fan") intersection() { union() { mount(); cam_solid(); } fan_solid(); }
else if (part == "check_insert") intersection() { mount(); tim_insert_path(); }
else if (part == "check_insert_cam") intersection() { cam_solid(); tim_insert_path(); }
else if (part == "mount") mount();
else if (part == "fit_test") fit_test();
// how it goes together: step1..step4, then "assembled" (all with the screws and strap), arm up
else if (part == "step1") rotate([180, 0, 0]) { flange_dummy(); color("Orange") mount(); bolts(35); dowel(-22); }
else if (part == "step2") rotate([180, 0, 0]) { flange_dummy(); color("Orange") mount(); bolts(0); dowel(0);
  translate([slide, 0, 75]) { color("DimGray") tim_box(); color("Gold", .8) tim_hood(); color("Black") tim_conn(); }
  color("Red") { arrow([tim_base_x + slide + 30, -y_in - wall - 12, tim_front_z + 70], [0, 0, -1], 60); arrow([tim_base_x + slide + 30, -y_in - wall - 12, tim_front_z + 4], [-1, 0, 0], 22); } }
else if (part == "step3") rotate([180, 0, 0]) { flange_dummy(); color("Orange") mount(); bolts(0); dowel(0); tim_dummy(fan = false);
  tim_screws(22); strap(); color("Red") arrow([x0 - 45, 0, tim_back_z + tim_holes[1]], [1, 0, 0], 30); }
else if (part == "step4") rotate([180, 0, 0]) { flange_dummy(); color("Orange") mount(); bolts(0); dowel(0); tim_dummy(fan = false); tim_screws(0); strap();
  cam_place() translate([0, 0, 60]) cam_body_only(); cam_screws(-45); color("Red") cam_place() arrow([0, -cam_w / 2 - 14, 70], [0, 0, -1], 55); }
else if (part == "assembled") rotate([180, 0, 0]) { flange_dummy(); color("Orange") mount(); hardware(); tim_dummy(fan = false); cam_dummy(); }
// separate solids for a multi-part 3MF (assembly orientation)
else if (part == "p_mount") rotate([180, 0, 0]) mount();
else if (part == "p_flange") rotate([180, 0, 0]) flange_dummy();
else if (part == "p_tim") rotate([180, 0, 0]) { tim_solid(); tim_plugs(); }
else if (part == "p_cam") rotate([180, 0, 0]) cam_place() { translate([-cam_h / 2, -cam_w / 2, 0.05]) cube([cam_h, cam_w, cam_d]); for (s = [-1, 1]) translate([33.9 - cam_h / 2, s * 11.2, -55]) cylinder(d = 15, h = 55); }
else if (part == "p_hw") rotate([180, 0, 0]) hardware();
// assembly view: turned so the arm is up and the belt is down
else rotate([180, 0, 0]) { color("Orange") mount(); tim_dummy(); cam_dummy(); flange_dummy(); }

// ------------------------------------------------------------------ screws, dowel, strap (for the assembly views)
module arrow(p, d, len) {   // from p along unit vector d
  translate(p) rotate([0, acos(d[2]), atan2(d[1], d[0])]) { cylinder(d = 3, h = len - 8); translate([0, 0, len - 8]) cylinder(d1 = 8, d2 = 0, h = 8); }
}
module bolts(e = 0) {       // 4 x M6 x 16 + DIN 9021 washers, pulled out by e along +Z
  color([0.25, 0.25, 0.27]) for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, pt - cb_depth + e]) {
    cylinder(d = 18, h = 1.6);
    translate([0, 0, 1.6 + e / 3]) { cylinder(d = 10, h = 6); translate([0, 0, -16]) cylinder(d = 6, h = 16); }
  }
}
module dowel(e = 0) { color("Silver") rotate(45) translate([fl_pcd / 2, 0, -9 + e]) cylinder(d = 6, h = 16); }
module tim_screws(e = 0) {  // 2 x M3 x 6 through the base wall into the TiM's base, 4 nylon-tipped set screws; pulled out by e
  color([0.25, 0.25, 0.27]) for (s = [-1, 1]) translate([x0 + 3 - e, s * tim_holes[0] / 2, tim_back_z + tim_holes[1]]) rotate([0, -90, 0]) {
    cylinder(d = 5.5, h = 3); translate([0, 0, -6]) cylinder(d = 3, h = 6);
  }
  color("White") for (s = [-1, 1], x = [tim_base_x + 10, tim_base_x + 28]) translate([x, s * (y_in + e / 2), optical_z]) rotate([s * -90, 0, 0]) cylinder(d = 3, h = wall);
}
module strap() {            // 8 mm strap through the slot above the TiM and round its front face
  color([0.1, 0.1, 0.1]) translate([-30, 0, 0]) {
    translate([0, -y_in - wall - 1.5, pt + 4.5]) cube([8, 2 * (y_in + wall) + 3, 1.5]);
    for (s = [-1, 1]) translate([0, s > 0 ? y_in + wall : -y_in - wall - 1.5, pt + 4.5]) cube([8, 1.5, tim_front_z + 1.5 - pt - 4.5]);
    translate([0, -y_in - wall - 1.5, tim_front_z]) cube([8, 2 * (y_in + wall) + 3, 1.5]);
  }
}
module cam_body_only() {
  color("SteelBlue") translate([-cam_h / 2, -cam_w / 2, 0]) cube([cam_h, cam_w, cam_d]);
  color("Black") for (s = [-1, 1]) translate([33.9 - cam_h / 2, s * 11.2, -55]) cylinder(d = 15, h = 55);
  color("Black") translate([0, 0, cam_d]) cylinder(d = 20, h = 2);   // lens
}
module cam_screws(e = 0) {  // 2 x M4 x 8 from the top of the plate; pulled out by e along the camera's -Z
  color([0.25, 0.25, 0.27]) cam_place() for (s = [-1, 1]) translate([12 - cam_h / 2, s * 15, -cam_under + e]) {
    translate([0, 0, -4]) cylinder(d = 7, h = 4); cylinder(d = 4, h = 8);
  }
}
module hardware() { bolts(0); dowel(0); tim_screws(0); strap(); cam_screws(0); }
