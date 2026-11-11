// Window sizes shared by the shell and the face.
// The pet window is fixed: it never resizes, so the sprite cannot jump when the
// bubble stack changes or the panel opens. The bubbles and panel windows are
// sized per content/open by the shell (see electron/main.cjs).
module.exports = {
  FULL: { width: 560, height: 800 }, // panel width
  PET: { width: 260, height: 222 },  // .petzone in faces/web/min.html
  MARGIN: 22,
};
