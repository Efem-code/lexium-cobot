# iPad only: run the bridge in a-Shell

No PC needed. The bridge (plain Python) runs on the iPad in the free **a-Shell**
app, and the page opens full screen inside a-Shell's own built-in browser, so it's
all one app: no Split View, and nothing gets paused.

**Switching:** swipe in from the **right edge** to go from the terminal to the page,
and from the **left edge** to go back to the terminal.

## One-time setup (iPad on a Wi-Fi with internet)

1. Install **a-Shell** from the App Store (free).
2. Open a-Shell and type these lines one at a time:

   ```
   cd ~/Documents
   curl -L -o lexium.tar.gz https://github.com/Efem-code/lexium-cobot/archive/refs/heads/main.tar.gz
   tar -xzf lexium.tar.gz
   cd lexium-cobot-main
   python3 ipad.py --sim
   ```

3. The page opens by itself after a second, showing the simulator. This checks
   everything works before you go near the cobot.
   If it doesn't open, type `internalbrowser http://127.0.0.1:8765` in a new a-Shell window.
4. Swipe back to the terminal and press **Ctrl+C** (on-screen keyboard: the `^` key, then `c`) to stop.

## Using it with the cobot

1. **Settings → Wi-Fi**: join the cobot's network (`8A23381JKA00023`, password on the label).
   The iPad has no internet while on it, which is fine.
2. Open a-Shell and run:

   ```
   cd ~/Documents/lexium-cobot-main
   python3 ipad.py
   ```

   The first time, iPadOS asks whether a-Shell may find devices on your **local network**: tap **Allow**.
   If you tapped Don't Allow, turn it on in **Settings → a-Shell → Local Network**.
3. The page opens inside a-Shell and connects to the cobot by itself
   (header shows **REAL 10.5.5.100**). It is **read-only** until you tick
   *Arm motion on real cobot* in Setup.
4. Keep a-Shell as the app on screen. If you switch to another app, iPadOS pauses
   a-Shell and the bridge stops with it; if that happens mid-jog, the jog watchdog
   stops the arm.

Options: `python3 ipad.py --host 10.5.5.101` for a different controller address,
`--sim` for the built-in simulator, `--safari` to skip the built-in browser and use
Safari instead (then a-Shell has to stay on screen in Split View).

## Updating to a newer version

Join a Wi-Fi with internet, then in a-Shell:

```
cd ~/Documents
rm -rf lexium-cobot-main lexium.tar.gz
curl -L -o lexium.tar.gz https://github.com/Efem-code/lexium-cobot/archive/refs/heads/main.tar.gz
tar -xzf lexium.tar.gz
```

Waypoints are kept: they live in Safari, not in this folder.

## Notes

- The bridge listens on `127.0.0.1` only, so nothing else on the cobot Wi-Fi can reach it
  and no PIN is needed.
- Keep only one app connected to the cobot (close Cobot Expert, stop the PC bridge).
  Several live connections at once overloaded the controller during testing.
- No Cobot Expert login or Local/Remote switch is needed: jogging from the page was
  verified with Cobot Expert left on Local.
