// Window sizes shared by the shell and the min face.
// FULL is the panel layout; SMALL is the collapsed pet (pet + bubbles above it).
// On Windows/macOS the window stays FULL and transparent margins stay click-through.
// On Linux the window resizes instead: XWayland cannot forward mouse moves, so a
// click-through window there can never take input back over the sprite.
module.exports = {
  // The panel is its own window now; FULL only supplies its width (560). The
  // height is computed per open from the room above/below the sprite.
  FULL: { width: 560, height: 800 },
  // Pet window: 320 wide; on Linux the face measures the bubble stack and asks
  // for a height that hugs it. Elsewhere the height stays 400 (bubbles + tooltip
  // fit) and the unused margin is click-through.
  SMALL: { width: 320, height: 400 },
  MARGIN: 22,
};
