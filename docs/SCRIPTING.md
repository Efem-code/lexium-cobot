# Scripting the cobot

Two ways, same command names:

- **Python** (`cobot.sdk.Robot`): full programs, files, libraries, version control. Runs on any PC (or the iPad in a-Shell).
- **JavaScript** in the page's **Script** tab: quick jobs, nothing to install, works in the demo too.

## Choosing where a Python script runs

| | `Robot.simulator()` | `Robot.bridge(url, pin=None)` | `Robot.connect(host)` |
|---|---|---|---|
| Talks to | a private simulator inside the script | the running app (PC, .exe or iPad) | the real controller directly |
| 3D view | no | yes, the page shows every move | no |
| Bridge limits + speed limit | yes | yes (the app's settings) | yes (this user's settings) |
| Real cobot motion | – | only if *Arm motion* is ticked in the page | only after `robot.arm()` |

Use `bridge()` for real work on the cobot: the page shows what the script is doing, STOP in the page stops it, and only one connection goes to the controller. `connect()` opens its own connection, so close the app first.

## Python API

```python
from cobot.sdk import Robot, CobotError

with Robot.simulator(powered=True) as robot:   # 'with' stops the arm if the script crashes
    ...
```

| Call | Does |
|---|---|
| `robot.joints`, `robot.pose`, `robot.state` | current joints (deg), TCP pose `[x, y, z, rx, ry, rz]` (mm, deg), full status dict |
| `robot.power_on()`, `power_off()`, `enable()`, `disable()`, `clear_error()` | controller state |
| `robot.arm(True)` | real cobot: allow motion and setting changes (same as *Arm motion*) |
| `robot.speed(percent)` | overall speed limit |
| `robot.move_joint(joints, speed=30, accel=100, relative=False, wait=True)` | joint move, all joints arrive together |
| `robot.move_linear(pose, speed=100, accel=500, relative=False, wait=True)` | straight-line TCP move |
| `robot.move_linear(z=200)`, `robot.move_linear(x=10, relative=True)` | change only some axes |
| `robot.move_pose(pose, speed=None)` | reach a pose with a joint move (IK in the bridge's model) |
| `robot.home(speed=None)` | ready pose `[0, 90, -90, 90, 90, 0]` |
| `robot.wait_until_stopped(timeout=120)` | after a `wait=False` move |
| `robot.stop()` | stop any move, jog or program now |
| `robot.set_do(i, True)`, `robot.do(i)`, `robot.di(i)` | digital outputs / inputs 0–15 |
| `robot.wait_di(i, True, timeout=None)` | wait for an input |
| `robot.set_payload(kg, (x, y, z))`, `robot.payload()` | payload mass and centre of mass (mm from the flange) |
| `robot.set_tool(slot, [x, y, z, rx, ry, rz])`, `robot.use_tool(slot)` | tool (TCP) slots 1–10, active tool |
| `robot.load_program(name)`, `run_program(name=None, wait=False)`, `pause_program()`, `resume_program()`, `program_state()` | programs stored on the controller |
| `robot.limits()`, `robot.limits(z_min=50, joint_speed_max=60, linear_speed_max=250)` | read or change the bridge limits |
| `robot.fk(joints)`, `robot.ik(pose)` | kinematics with the active tool |
| `robot.command(name, **fields)` | any raw JAKA JSON command |
| `robot.sleep(s)` | wait |

Errors: every refused command, bridge limit, E-stop, protective stop or controller error during a wait raises `CobotError` with the reason.

Units: mm and degrees; speeds in deg/s (joint) and mm/s (linear), before the speed limit applies.

## JavaScript (Script tab)

The same names, `await`ed, with options in an object:

```js
await robot.speed(30);
await robot.home();
const [x, y, z] = robot.pose;
await robot.move_linear({z: z - 50}, {speed: 150});
await robot.move_joint([0, 0, 0, 0, 0, 45], {relative: true});
await robot.set_do(0, true);
await robot.wait_di(1, true, 10);
log("done at", robot.pose);
await sleep(0.5);           // seconds
P[0].joints;                 // your taught waypoints
```

**Stop** aborts the script at its next command and stops the arm. On the real cobot the page asks before running, and needs *Arm motion*.

## Tips

- Develop against `Robot.simulator()` or the demo, then switch one line to `Robot.bridge()`.
- Start real runs at 10 % and raise the speed once the path is proven.
- Set the **floor limit** (Setup → Bridge limits) to just above the table: a typo in Z then gets refused, not driven into the table.
- Teach poses with the jog buttons, then copy them from the Points list or `robot.pose` into your script.
