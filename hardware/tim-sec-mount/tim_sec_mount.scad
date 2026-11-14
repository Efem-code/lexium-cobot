// Tool mount for the Lexium Cobot LXMRL03 (JAKA Zu 3 flange): a SICK TiM5xx/7xx 2D LiDAR and a SICK sensingCam SEC110.
//
// Coordinates = the cobot's flange frame: the flange face is Z 0 and +Z points away from the arm (towards the belt).
// That is also the print orientation of the bracket: the flange face lies on the bed.
//
// The TiM lies on its side: its hood axis runs along +X (the direction of travel), its front (the 90° beam) points
// down at the belt and its connectors point up at the arm. Its scan plane is the flange's Y-Z plane (X 0), so the
// fan stands across the belt and its 90° blind sector (around the connectors) faces the arm.
// The SEC110 hangs under the +X end of the plate, looking down, tilted back towards the scan line.
//
// Sources (read from the documents, Nov 2026):
//   Flange: Schneider Hardware Guide EIO0000004783, p.41-42: 4 x M6 on Ø50, 7 mm deep; pin hole Ø6 H7 on Ø50 at 45°
//           between two bolts; centring spigot Ø63 (5.5 high), recess Ø31.5.
//   TiM:    SICK datasheets TiM571-2050101 / TiM781-2174101 p.5: body 60 x 61 x 85.75 mm, light emission 62.46 mm
//           above the base, swivel connector unit at the back, 15.4 mm past the base and 17.4 mm behind the back.
//   SEC110: SICK datasheet SEC110-5C9D1SFZZZZ p.5: 57.5 x 49 x 33.6 mm; back: 2 x M4 30 mm apart, 12 mm from the
//           bottom edge; two M12 connectors 22.4 mm apart, 33.9 mm from the bottom edge, 10.2 mm proud of the back.
//
// Render one part:  openscad -D 'part="bracket"' -o bracket.stl tim_sec_mount.scad
// part = "assembly" (preview only), "bracket", "camera_bracket", "fit_test"

part = "assembly";

/* [Print] */
clr = 0.4;          // clearance around the sensors (per side)
$fn = 64;

/* [Flange: LXMRL03] */
fl_pcd   = 50;      // bolt circle
fl_bolt  = 6.6;     // M6 clearance
fl_head  = 11;      // M6 socket head counterbore
fl_pin   = 6.1;     // Ø6 dowel (print undersize, ream or press)
fl_d     = 68;      // flange body diameter (dummy only)
pt       = 10;      // plate thickness
cb_depth = 4;       // head counterbore depth: leaves pt - cb_depth = 6 mm under the head (M6 x 12 screws)

/* [TiM5xx/7xx] */
tim_w = 60; tim_d = 61; tim_h = 85.75;
tim_scan = 62.46;           // scan plane above the base
tim_conn_below = 15.37;     // connector unit below the base (101.12 - 85.75)
tim_conn_behind = 17.37;    // connector unit behind the back face
tim_conn_from_back = 14.3;  // connector unit reaches this far into the body from the back (61 - 46.71)
gap = 22;                   // plate underside to TiM back face: room for the connector unit
cradle_len = 20;            // how far along the TiM body the cradle grips (stays clear of the M3 side recesses at 24.4)
wall = 5;

/* [SEC110] */
cam_w = 57.5; cam_h = 49; cam_d = 33.6;
cam_x = 62;         // camera centre along X (clears the TiM hood at full tilt)
cam_drop = 34;      // plate underside to the camera's back face: room for right-angle M12 plugs
cam_tilt = 15;      // degrees, looking back towards the scan line (X 0)
cam_pt = 5;         // camera plate thickness

fan_r = 140;        // laser fan drawn in the assembly view, mm

/* [Derived] */
tim_back_z  = pt + gap;                 // TiM back face (connector side)
tim_front_z = tim_back_z + tim_d;       // TiM front face (towards the belt)
tim_base_x  = -tim_scan;                // TiM base; hood top at tim_h - tim_scan
optical_z   = tim_back_z + tim_d / 2;   // scan origin: hood axis, mid-depth
plate_x0 = tim_base_x - wall - clr - 1;
plate_x1 = cam_x + cam_h / 2 + 2; plate_y = tim_w / 2 + clr + wall;

echo(str("TiM scan origin (tool TCP): X 0, Y 0, Z ", optical_z, " mm from the flange face"));

module rrect(x0, x1, y, r, h) {
  hull() for (x = [x0 + r, x1 - r], s = [-1, 1]) translate([x, s * (y - r), 0]) cylinder(r = r, h = h);
}

// ------------------------------------------------------------------ bracket: flange plate + TiM cradle
module bracket() {
  difference() {
    union() {
      rrect(plate_x0, plate_x1, plate_y, 6, pt);
      cradle();
      // gussets between the plate and the cradle walls
      for (s = [-1, 1]) hull() {
        translate([plate_x0, s * (plate_y - wall / 2) - wall / 2, pt - 1]) cube([wall + clr + 1 + cradle_len + 10, wall, 1]);
        translate([plate_x0, s * (plate_y - wall / 2) - wall / 2, pt]) cube([1, wall, tim_back_z - pt]);
      }
    }
    flange_holes();
    // M4 holes for the camera bracket (heat-set inserts from the top, or nuts)
    for (s = [-1, 1]) translate([cam_x, s * (cam_w / 2 - 2), -1]) cylinder(d = 5.6, h = pt + 2);
    // cable window over the camera's connectors
    translate([cam_x + (33.9 - cam_h / 2) - 11, -21, -1]) cube([22, 42, pt + 2]);
  }
}
module flange_holes() {
  for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, 0]) {
    translate([0, 0, -1]) cylinder(d = fl_bolt, h = pt + 2);
    translate([0, 0, pt - cb_depth]) cylinder(d = fl_head, h = cb_depth + 1);
  }
  rotate(45) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_pin, h = 8);   // blind: the pin stays in the plate
  // the arm's centring recess (Ø31.5) and the spigot sit under the plate: nothing to cut
}
// The cradle grips the TiM's base end: a back wall against the base (cut away where the connector unit hangs),
// two side walls along the body, and a lip under the front edge. The TiM slides in along -X before the camera goes on.
module cradle() {
  x0 = tim_base_x - clr - wall; x1 = tim_base_x + cradle_len; y_in = tim_w / 2 + clr;
  z_top = pt; z_bot = tim_front_z + clr + wall;
  difference() {
    union() {
      for (s = [-1, 1]) translate([x0, s > 0 ? y_in : -y_in - wall, z_top]) cube([x1 - x0, wall, z_bot - z_top]);   // side walls
      translate([x0, -y_in - wall, z_top]) cube([wall, 2 * (y_in + wall), z_bot - z_top]);                          // base wall
      // front lip, chamfered so it prints without support
      translate([x0, -y_in, tim_front_z + clr]) hull() {
        cube([wall + 12, 2 * y_in, wall]);
        cube([wall, 2 * y_in, 0.01]);
      }
    }
    // window in the base wall for the connector unit and its plugs
    translate([x0 - 1, -23, tim_back_z - tim_conn_behind - 2]) cube([wall + 2, 46, tim_conn_behind + tim_conn_from_back + 4]);
    // M3 heat-set inserts (Ø4.0, 6 deep) for nylon-tipped set screws that pinch the TiM
    for (s = [-1, 1], z = [tim_back_z + 18, tim_front_z - 18])
      translate([tim_base_x + cradle_len / 2, s * (y_in + wall / 2), z]) rotate([90, 0, 0]) cylinder(d = 4.0, h = wall + 2, center = true);
  }
}

// ------------------------------------------------------------------ camera bracket (separate print)
// In cam_place(): X along the camera's 49 mm side (its bottom edge at -24.5, connectors towards +X), Y along 57.5,
// Z 0 = the camera's back face, +Z = the lens side (down), -Z = the plate and the arm.
module cam_place() {
  translate([cam_x, 0, pt + cam_drop]) rotate([0, -cam_tilt, 0]) children();   // tilt: the lens turns towards -X
}
module camera_bracket() {
  difference() {
    union() {
      cam_place() translate([-cam_h / 2, -cam_w / 2 - 6, -cam_pt]) cube([cam_h, cam_w + 12, cam_pt]);
      for (s = [-1, 1]) hull() {
        translate([cam_x - 9, s * (cam_w / 2 - 2) - 6, pt]) cube([18, 12, 0.01]);
        cam_place() translate([-cam_h / 2, s > 0 ? cam_w / 2 : -cam_w / 2 - 6, -cam_pt]) cube([cam_h, 6, cam_pt]);
      }
    }
    // M4 screws up into the plate (inserts there), heads in counterbores from below
    for (s = [-1, 1]) translate([cam_x, s * (cam_w / 2 - 2), pt - 1]) { cylinder(d = 4.4, h = 60); translate([0, 0, 12]) cylinder(d = 8, h = 60); }
    cam_place() {
      // M4 screws into the camera's back: 30 mm apart, 12 mm from its bottom edge
      for (s = [-1, 1]) translate([12 - cam_h / 2, s * 15, -cam_pt - 1]) { cylinder(d = 4.4, h = cam_pt + 2); translate([0, 0, cam_pt - 1]) cylinder(d = 8, h = 3); }
      // window for the two M12 connectors (22.4 apart, 33.9 from the bottom edge)
      translate([33.9 - cam_h / 2 - 10, -22, -cam_pt - 1]) cube([cam_h - 33.9 + 10 + 1, 44, cam_pt + 2]);
    }
  }
}

// ------------------------------------------------------------------ fit test: print this first (≈ 20 min)
// Checks the flange bolt pattern and dowel hole, the counterbores, the M3 and M4 insert holes, and the TiM width.
module fit_test() {
  difference() {
    union() {
      cylinder(d = 64, h = 5);
      translate([-tim_w / 2 - clr - wall, 36, 0]) cube([tim_w + 2 * clr + 2 * wall, 14, 5]);
      for (s = [-1, 1]) translate([s > 0 ? tim_w / 2 + clr : -tim_w / 2 - clr - wall, 36, 0]) cube([wall, 14, 12]);
    }
    for (a = [0, 90, 180, 270]) rotate(a) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_bolt, h = 10);
    rotate(45) translate([fl_pcd / 2, 0, -1]) cylinder(d = fl_pin, h = 10);
    translate([0, 0, -1]) cylinder(d = 32, h = 10);   // see the arm's centring recess through it
    translate([-12, 25, -1]) cylinder(d = 4.0, h = 10);   // M3 insert
    translate([12, 25, -1]) cylinder(d = 5.6, h = 10);    // M4 insert
  }
}

// ------------------------------------------------------------------ dummies for the assembly view
module tim_dummy() {
  color("DimGray") translate([tim_base_x, -tim_w / 2, tim_back_z]) cube([tim_h - 27.3, tim_w, tim_d]);
  color("Gold", .8) translate([tim_base_x + tim_h - 27.3, 0, optical_z]) rotate([0, 90, 0]) cylinder(d = 50, h = 27.3);
  color("Black") translate([tim_base_x - tim_conn_below, -18, tim_back_z - tim_conn_behind]) cube([tim_conn_below + 10, 36, tim_conn_behind + tim_conn_from_back]);
  color("Red", .25) translate([0, 0, optical_z]) rotate([0, 90, 0]) linear_extrude(0.5) polygon([[0, 0], for (a = [-45:5:225]) fan_r * [-sin(a), cos(a)]]);   // 90° = straight down, blind sector up
}
module cam_dummy() {
  cam_place() {
    color("SteelBlue") translate([-cam_h / 2, -cam_w / 2, 0]) cube([cam_h, cam_w, cam_d]);                       // body, lens down
    color("Black") for (s = [-1, 1]) translate([33.9 - cam_h / 2, s * 11.2, -10.2]) cylinder(d = 15, h = 10.2);    // M12s, up
  }
}
module flange_dummy() { color("Silver") translate([0, 0, -30]) cylinder(d = fl_d, h = 30); }

if (part == "bracket") bracket();
else if (part == "camera_bracket") rotate([90, 0, 0]) camera_bracket();   // printed on its side: the profile is extruded along Y
else if (part == "fit_test") fit_test();
// assembly view: turned so the arm is up and the belt is down
else rotate([180, 0, 0]) { color("Orange") bracket(); color("DarkOrange") camera_bracket(); tim_dummy(); cam_dummy(); flange_dummy(); }
