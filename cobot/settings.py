"""Per-user settings file (bridge limits, PIN, ...), shared by run.py, ipad.py and installs.

Windows: %APPDATA%\\LexiumCobot\\settings.json ; elsewhere: ~/.lexium-cobot/settings.json
(iPad/a-Shell, where only ~/Documents is writable: ~/Documents/.lexium-cobot)
"""
import json
import os
import tempfile

_dir = None


def config_dir():
    global _dir
    if _dir:
        return _dir
    home = os.path.expanduser("~")
    candidates = [os.environ.get("LEXIUM_COBOT_HOME")]  # tests / portable installs
    if os.environ.get("APPDATA"):
        candidates.append(os.path.join(os.environ["APPDATA"], "LexiumCobot"))
    candidates += [os.path.join(home, ".lexium-cobot"), os.path.join(home, "Documents", ".lexium-cobot"),
                   os.path.join(tempfile.gettempdir(), "lexium-cobot")]
    for d in filter(None, candidates):
        try:
            os.makedirs(d, exist_ok=True)
            probe = os.path.join(d, ".write-test")
            with open(probe, "w"):
                pass
            os.remove(probe)
            _dir = d
            return d
        except OSError:
            continue
    raise OSError("no writable folder for settings")


def path():
    return os.path.join(config_dir(), "settings.json")


def load():
    try:
        with open(path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(data):
    tmp = path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path())


def update(key, value):
    data = load()
    data[key] = value
    try:
        save(data)
    except OSError:
        pass  # settings are a convenience: never stop the robot code over them
