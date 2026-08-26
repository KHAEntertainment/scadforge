/* [Main] */
// Cup outer diameter
cup_diameter = 80;  // [50:150]
// Cup height
cup_height = 90;  // [60:150]
// Wall thickness
wall_thickness = 3;  // [2:10]
// Base diameter
base_diameter = 100;  // [60:180]
// Base height
base_height = 5;  // [3:15]

/* [Handle] */
// Handle width (distance from cup)
handle_width = 25;  // [15:50]
// Handle thickness
handle_thickness = 10;  // [6:20]
// Handle vertical position from bottom
handle_position = 45;  // [20:100]
// Handle height
handle_height = 50;  // [30:80]

/* [Quality] */
// Fragment number for circles
$fn = 64;  // [24:128]

module mug() {
    union() {
        // Base/saucer
        cylinder(h = base_height, d = base_diameter);
        
        // Cup body - hollow cylinder
        difference() {
            translate([0, 0, base_height])
                cylinder(h = cup_height, d = cup_diameter);
            translate([0, 0, base_height + wall_thickness])
                cylinder(h = cup_height, d = cup_diameter - 2 * wall_thickness);
        }
        
        // Loop handle - semicircular tube attached to cup side
        translate([cup_diameter/2 - wall_thickness/2, 0, base_height + handle_position]) {
            // Semicircular loop
            rotate([90, 0, 0])
                rotate_extrude(angle = 180)
                    translate([handle_width/2 + handle_thickness/2, 0, 0])
                        circle(d = handle_thickness);
            
            // Upper attachment - extends into cup wall
            translate([0, handle_width/2, handle_height/2])
                rotate([0, 90, 0])
                    cylinder(h = wall_thickness * 2, d = handle_thickness);
            
            // Lower attachment - extends into cup wall
            translate([0, handle_width/2, -handle_height/2])
                rotate([0, 90, 0])
                    cylinder(h = wall_thickness * 2, d = handle_thickness);
        }
    }
}

mug();
