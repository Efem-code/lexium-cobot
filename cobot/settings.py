"""Per-user settings file (bridge limits, PIN, ...), shared by run.py, ipad.py and installs.

Windows: %APPDATA%\\LexiumCobot\\settings.json ; elsewhere: ~/.lexium-cobot/settings.json
"""
import json
import os


def config_dir():
    if os.environ.get("LEXIUM_COBOT_HOME"):  # tests / portable installs
        d = os.environ["LEXIUM_COBOT_HOME"]
        os.makedirs(d, exist_ok=True)
        return d
    base = os.environ.get("APPDATA")
    d = os.path.join(base, "LexiumCobot") if base else os.path.join(os.path.expanduser("~"), ".lexium-cobot")
    os.makedirs(d, exist_ok=True)
    return d


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
    save(data)
