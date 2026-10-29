# iPad only: run the bridge in a-Shell

No PC needed. The bridge (plain Python) runs on the iPad in the free **a-Shell**
app, and Safari on the same iPad opens it at `http://127.0.0.1:8765`.

## One-time setup (iPad on a Wi-Fi with internet)

1. Install **a-Shell** from the App Store (free).
2. Open a-Shell and type these lines one at a time:

   ```
   cd ~/Documents
   curl -L -o lexium.zip https://github.com/Efem-code/lexium-cobot/archive/refs/heads/main.zip
   tar -xf lexium.zip
   cd lexium-cobot-main
   python3 ipad.py --sim
   ```

   If `tar` doesn't unpack the zip, use `unzip lexium.zip` instead.
3. Open Safari at `http://127.0.0.1:8765`. You should see the simulator.
   This checks everything works before you go near the cobot.
4. Back in a-Shell press **Ctrl+C** (on-screen keyboard: the `^` key, then `c`) to stop.

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
3. Put a-Shell and Safari **side by side** (Split View: drag Safari up from the Dock onto the
   side of the screen). iPadOS pauses apps that are off screen, and the bridge stops with it.
   If that happens mid-jog, the jog watchdog stops the arm.
4. In Safari open `http://127.0.0.1:8765`. The page connects to the cobot by itself
   (header shows **REAL 10.5.5.100**). It is **read-only** until you tick
   *Arm motion on real cobot* in Setup.

Options: `python3 ipad.py --host 10.5.5.101` for a different controller address,
`--sim` for the built-in simulator.

## Updating to a newer version

Join a Wi-Fi with internet, then in a-Shell:

```
cd ~/Documents
rm -rf lexium-cobot-main lexium.zip
curl -L -o lexium.zip https://github.com/Efem-code/lexium-cobot/archive/refs/heads/main.zip
tar -xf lexium.zip
```

Waypoints are kept: they live in Safari, not in this folder.

## Notes

- The bridge listens on `127.0.0.1` only, so nothing else on the cobot Wi-Fi can reach it
  and no PIN is needed.
- Keep only one app connected to the cobot (close Cobot Expert, stop the PC bridge).
  Several live connections at once overloaded the controller during testing.
- Login and the Local/Remote switch are not built yet; until then, switch to Remote
  in Cobot Expert or on the pendant.
