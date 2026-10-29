"""Virtual Lexium Cobot Controller.

Starts a SimRobot and exposes it on the same network interfaces as the real
Lexium Cobot Controller:
  * Modbus TCP   (default port 502)  -- Schneider's published address table
  * JSON command (default port 10001) -- JAKA-style remote protocol
  * JSON status  (default port 10000) -- JAKA-style status stream

Anything that can talk to the real controller (this PC app, Modbus tools,
later the TM262 PLC) can point at this PC instead.
"""
import threading
import time

from . import regmap as RM
from .jaka_proto import JakaServer
from .modbus import DataStore, ModbusServer
from .sim_robot import SimRobot


class VirtualController:
    def __init__(self, host="127.0.0.1", modbus_port=502, cmd_port=10001, status_port=10000,
                 model="LXMRL03"):
        self.robot = SimRobot(model)
        self.store = DataStore()
        self.store.on_write = self._on_modbus_write
        self.modbus = ModbusServer(host, modbus_port, self.store)
        self.jaka = JakaServer(self.robot, host, cmd_port, status_port)
        self.host = host
        self.ports = dict(modbus=modbus_port, cmd=cmd_port, status=status_port)

    def _on_modbus_write(self, area, addr, values):
        # Master writes to robot DI coils (40..167) -> robot digital inputs
        if area == "coils":
            for i, v in enumerate(values):
                idx = addr + i - RM.COIL_DI_BASE
                if 0 <= idx < RM.IO_COUNT:
                    self.robot.set_din(idx, v)
        elif area == "holding":
            for i, v in enumerate(values):
                idx = addr + i - RM.HREG_AI_BASE
                if 0 <= idx < 32:
                    self.robot.ain[idx] = v

    def _publish(self):
        while not getattr(self, "_stopped", False):
            words = RM.build_block(self.robot.modbus_values())
            self.store.write("inputs", RM.ROBOT_DATA_START, words)
            s = self.robot.snapshot()
            self.store.write("discrete", RM.DISCRETE_DO_BASE, s["dout"])
            # reflect the robot's actual DI (set by a master write *or* inside the sim)
            self.store.write("coils", RM.COIL_DI_BASE, s["din"][:RM.IO_COUNT])
            time.sleep(0.01)

    def start(self):
        self.robot.start()
        self.modbus.start()
        self.jaka.start()
        threading.Thread(target=self._publish, daemon=True, name="modbus-publish").start()
        return self

    def stop(self):
        self._stopped = True
        self.jaka.stop()
        self.modbus.shutdown()
        self.modbus.server_close()
        self.robot.shutdown()
