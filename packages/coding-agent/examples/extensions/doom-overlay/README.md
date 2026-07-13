# DOOM Overlay Demo

Play DOOM as an overlay in volt. Demonstrates that the overlay system can handle real-time game rendering at 35 FPS.

## Usage

This source-only demo does not ship precompiled Doom code. Install Emscripten,
then build the GPL-2.0 DoomGeneric dependency locally from the exact source
revision pinned in `doom/build.sh`:

```bash
./examples/extensions/doom-overlay/doom/build.sh
```

The generated `doom.js`, `doom.wasm`, cloned upstream source, and downloaded
WAD are ignored and must not be committed or included in Volt release
artifacts. Review DoomGeneric's GPL-2.0 license before redistributing a local
build.

```bash
volt --extension ./examples/extensions/doom-overlay
```

Then run:
```
/doom-overlay
```

The shareware WAD file (~4MB) is auto-downloaded on first run and remains
local-only.

## Controls

| Action | Keys |
|--------|------|
| Move | WASD or Arrow Keys |
| Run | Shift + WASD |
| Fire | F or Ctrl |
| Use/Open | Space |
| Weapons | 1-7 |
| Map | Tab |
| Menu | Escape |
| Pause/Quit | Q |

## How It Works

DOOM runs as WebAssembly compiled from [doomgeneric](https://github.com/ozkl/doomgeneric). Each frame is rendered using half-block characters (▀) with 24-bit color, where the top pixel is the foreground color and the bottom pixel is the background color.

The overlay uses:
- `width: "90%"` - 90% of terminal width
- `maxHeight: "80%"` - Maximum 80% of terminal height
- `anchor: "center"` - Centered in terminal

Height is calculated from width to maintain DOOM's 3.2:1 aspect ratio (accounting for half-block rendering).

## Credits

- [id Software](https://github.com/id-Software/DOOM) for the original DOOM
- [doomgeneric](https://github.com/ozkl/doomgeneric) for the portable DOOM implementation
- [volt-doom](https://github.com/badlogic/volt-doom) for the original volt integration
