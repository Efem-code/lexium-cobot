"""Forward / inverse kinematics for 6-axis Lexium Cobot arms (stdlib only).

Geometry uses JAKA's modified (Craig) DH convention, the same one the real
controller reports joints in. The LXMRL03 values were read from a real
controller with the JSON command {"cmdName": "get_dh_param"}; with nominal
alphas and no theta offsets they reproduce the controller's own TCP readout
to ~0.1 mm. The other models use JAKA Zu nominal values (unverified).

Units: mm and degrees at the API surface, radians internally.
Pose = [X, Y, Z, RX, RY, RZ]  (RX/RY/RZ = fixed-axis XYZ euler, R = Rz*Ry*Rx)
"""
import math

D2R = math.pi / 180.0
R2D = 180.0 / math.pi

# d1, a2, a3, d4, d5, d6 (mm); reach (mm); payload (kg); max joint speed (deg/s)
# Modified DH: a = [0, 0, a2, a3, 0, 0], d = [d1, 0, 0, -d4, d5, d6]
PROFILES = {
    "LXMRL03": dict(name="Lexium Cobot L03 (3 kg)", d1=150.255, a2=246.914, a3=227.688,
                    d4=113.122, d5=118.09, d6=105.926, reach=626, payload=3, vmax=180),
    "LXMRL07": dict(name="Lexium Cobot L07 (7 kg)", d1=120.15, a2=360.0, a3=303.5,
                    d4=113.5, d5=113.5, d6=107.0, reach=819, payload=7, vmax=180),
    "LXMRL12": dict(name="Lexium Cobot L12 (12 kg)", d1=142.65, a2=595.0, a3=571.5,
                    d4=131.5, d5=115.5, d6=105.5, reach=1327, payload=12, vmax=120),
    "LXMRL18": dict(name="Lexium Cobot L18 (18 kg)", d1=166.0, a2=476.0, a3=420.0,
                    d4=160.0, d5=129.0, d6=118.0, reach=1073, payload=18, vmax=120),
}

# Joint soft limits (deg) -- JAKA Zu style.
JOINT_LIMITS = [(-360, 360), (-85, 265), (-175, 175), (-85, 265), (-360, 360), (-360, 360)]

ALPHA = [0.0, 90.0, 0.0, 0.0, 90.0, -90.0]  # modified-DH link twists (deg)

HOME = [0.0, 90.0, -90.0, 90.0, 90.0, 0.0]  # elbow-up ready pose, tool down (deg)


# ---------------------------------------------------------------- matrices
def mat_mul(A, B):
    n, m, p = len(A), len(B), len(B[0])
    return [[sum(A[i][k] * B[k][j] for k in range(m)) for j in range(p)] for i in range(n)]


def transpose(A):
    return [list(r) for r in zip(*A)]


def mdh(alpha, a, theta, d):
    """Modified DH: RotX(alpha) * TransX(a) * RotZ(theta) * TransZ(d)."""
    ct, st, ca, sa = math.cos(theta), math.sin(theta), math.cos(alpha), math.sin(alpha)
    return [[ct, -st, 0.0, a],
            [st * ca, ct * ca, -sa, -sa * d],
            [st * sa, ct * sa, ca, ca * d],
            [0.0, 0.0, 0.0, 1.0]]


def rpy_to_R(rx, ry, rz):
    cx, sx, cy, sy, cz, sz = (math.cos(rx), math.sin(rx), math.cos(ry),
                              math.sin(ry), math.cos(rz), math.sin(rz))
    return [[cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx]]


def R_to_rpy(R):
    sy = -R[2][0]
    if abs(sy) < 0.999999:
        ry = math.asin(sy)
        rx = math.atan2(R[2][1], R[2][2])
        rz = math.atan2(R[1][0], R[0][0])
    else:  # gimbal lock
        ry = math.copysign(math.pi / 2, sy)
        rx = math.atan2(-R[1][2], R[1][1])
        rz = 0.0
    return rx, ry, rz


def rot_to_axis_angle(R):
    """Rotation matrix -> rotation vector (axis * angle)."""
    c = max(-1.0, min(1.0, (R[0][0] + R[1][1] + R[2][2] - 1) / 2))
    ang = math.acos(c)
    if ang < 1e-9:
        return [0.0, 0.0, 0.0]
    if abs(math.pi - ang) < 1e-4:
        # near 180 deg: take axis from the diagonal
        x = math.sqrt(max(0.0, (R[0][0] + 1) / 2))
        y = math.copysign(math.sqrt(max(0.0, (R[1][1] + 1) / 2)), R[0][1] or 1)
        z = math.copysign(math.sqrt(max(0.0, (R[2][2] + 1) / 2)), R[0][2] or 1)
        return [x * ang, y * ang, z * ang]
    s = 2 * math.sin(ang)
    return [(R[2][1] - R[1][2]) / s * ang, (R[0][2] - R[2][0]) / s * ang, (R[1][0] - R[0][1]) / s * ang]


def axis_angle_to_R(v):
    ang = math.sqrt(sum(x * x for x in v))
    if ang < 1e-12:
        return [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]]
    x, y, z = (c / ang for c in v)
    c, s, C = math.cos(ang), math.sin(ang), 1 - math.cos(ang)
    return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
            [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
            [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]


def solve(A, b):
    """Gaussian elimination with partial pivoting. A is n x n."""
    n = len(A)
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-12:
            raise ValueError("singular")
        M[col], M[piv] = M[piv], M[col]
        for r in range(n):
            if r != col:
                f = M[r][col] / M[col][col]
                if f:
                    for k in range(col, n + 1):
                        M[r][k] -= f * M[col][k]
    return [M[i][n] / M[i][i] for i in range(n)]


# ---------------------------------------------------------------- arm model
class Arm:
    def __init__(self, model="LXMRL03"):
        self.set_model(model)

    def set_model(self, model):
        if model not in PROFILES:
            raise ValueError(f"unknown model {model}; choose {list(PROFILES)}")
        self.model = model
        p = PROFILES[model]
        self.profile = p
        # modified DH, JAKA convention
        self.d = [p["d1"], 0.0, 0.0, -p["d4"], p["d5"], p["d6"]]
        self.a = [0.0, 0.0, p["a2"], p["a3"], 0.0, 0.0]
        self.alpha = [x * D2R for x in ALPHA]
        self.tool = [0.0] * 6  # TCP offset (mm, deg) relative to flange

    def frames(self, q_deg):
        """All link frames (base..flange..tcp) as 4x4 matrices."""
        T = [[1.0, 0, 0, 0], [0, 1.0, 0, 0], [0, 0, 1.0, 0], [0, 0, 0, 1.0]]
        out = [T]
        for i in range(6):
            T = mat_mul(T, mdh(self.alpha[i], self.a[i], q_deg[i] * D2R, self.d[i]))
            out.append(T)
        tx, ty, tz, rx, ry, rz = self.tool
        Rt = rpy_to_R(rx * D2R, ry * D2R, rz * D2R)
        Tt = [Rt[0] + [tx], Rt[1] + [ty], Rt[2] + [tz], [0, 0, 0, 1.0]]
        out.append(mat_mul(T, Tt))
        return out

    def fk_T(self, q_deg):
        return self.frames(q_deg)[-1]

    def fk(self, q_deg):
        T = self.fk_T(q_deg)
        R = [row[:3] for row in T[:3]]
        rx, ry, rz = R_to_rpy(R)
        return [T[0][3], T[1][3], T[2][3], rx * R2D, ry * R2D, rz * R2D]

    def joint_points(self, q_deg):
        """Physical skeleton for drawing, matching the real arm's layout:
        [base, shoulder (J2), elbow (J3), elbow after the sideways step,
         wrist 1 (J4), wrist 2 (J5), flange (J6), tcp].

        The DH model puts the whole d4 side offset at J4. On the real arm the
        forearm steps sideways inside the elbow housing, so the step is drawn
        there instead. The joint positions and the TCP are unchanged.
        """
        F = self.frames(q_deg)
        org = [[T[0][3], T[1][3], T[2][3]] for T in F]
        z3 = [F[3][0][2], F[3][1][2], F[3][2][2]]
        d4 = self.d[3]
        step = [org[3][k] + z3[k] * d4 for k in range(3)]
        return [[0.0, 0.0, 0.0], org[2], org[3], step, org[4], org[5], org[6], org[7]]

    # ---------- jacobian / IK
    def _pose_err(self, T, Tt):
        dp = [Tt[i][3] - T[i][3] for i in range(3)]
        R = [r[:3] for r in T[:3]]
        Rt = [r[:3] for r in Tt[:3]]
        dR = mat_mul(Rt, transpose(R))
        w = rot_to_axis_angle(dR)
        return dp + w

    def jacobian(self, q_deg, eps=1e-4):
        """Numeric geometric jacobian, columns per joint (per radian)."""
        T0 = self.fk_T(q_deg)
        J = [[0.0] * 6 for _ in range(6)]
        for j in range(6):
            q = list(q_deg)
            q[j] += eps * R2D
            e = self._pose_err(T0, self.fk_T(q))
            for i in range(6):
                J[i][j] = e[i] / eps
        return J

    def pose_to_T(self, pose):
        x, y, z, rx, ry, rz = pose
        R = rpy_to_R(rx * D2R, ry * D2R, rz * D2R)
        return [R[0] + [x], R[1] + [y], R[2] + [z], [0, 0, 0, 1.0]]

    def ik(self, pose, seed, iters=120, tol_mm=0.05, tol_rad=1e-4):
        """Damped least squares IK. Returns joint list (deg) or raises ValueError."""
        Tt = self.pose_to_T(pose)
        q = list(seed)
        lam = 5.0  # damping (mm scale)
        for _ in range(iters):
            T = self.fk_T(q)
            e = self._pose_err(T, Tt)
            # weight rotation error into mm-equivalent so both terms matter
            w = 300.0
            ew = e[:3] + [x * w for x in e[3:]]
            if math.sqrt(sum(x * x for x in e[:3])) < tol_mm and \
                    math.sqrt(sum(x * x for x in e[3:])) < tol_rad:
                return self._wrap_to_seed(q, seed)
            J = self.jacobian(q)
            Jw = J[:3] + [[x * w for x in row] for row in J[3:]]
            JT = transpose(Jw)
            A = mat_mul(Jw, JT)
            for i in range(6):
                A[i][i] += lam * lam
            try:
                y = solve(A, ew)
            except ValueError:
                break
            dq = [sum(JT[i][k] * y[k] for k in range(6)) for i in range(6)]
            # clamp step size (rad) to keep it stable
            m = max(abs(x) for x in dq)
            if m > 0.2:
                dq = [x * 0.2 / m for x in dq]
            q = [q[i] + dq[i] * R2D for i in range(6)]
        raise ValueError("IK did not converge (target unreachable or singular)")

    @staticmethod
    def _wrap_to_seed(q, seed):
        out = []
        for a, s in zip(q, seed):
            while a - s > 180:
                a -= 360
            while a - s < -180:
                a += 360
            out.append(a)
        return out


def within_limits(q):
    return all(lo - 1e-6 <= v <= hi + 1e-6 for v, (lo, hi) in zip(q, JOINT_LIMITS))
