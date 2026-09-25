# Clear Download Manager UI contract

This contract is the visual boundary for the final Motion attempt.

- Preserve the current desktop layout, dimensions, density, responsive rules, and Main/Settings geometry.
- Keep the clean dark-blue/cyan desktop aesthetic. No neon, 3D, glow, shine sweep, or decorative noise.
- Never add flying selection boxes, giant selected surfaces, double borders, arbitrary bounce, ripple, or geometry-changing effects.
- Main ↔ Settings keeps the existing human-approved transition as the reference and must not be redesigned for library consistency.
- Navbar selection is local: a 72×72 hitbox with the approved approximately 64×64 visible surface; nothing travels between items.
- Context menus, dropdowns, popovers, dialogs, and inspectors keep their current child layout and positioning authority. Motion may animate only their visual surface.
- Theme changes may animate appearance but never move or resize Main, cards, rows, or positioning roots.
- Every significant effect must be noticeable at normal speed, documented in `docs/CDM-MOTION-CATALOG.md`, and have a reduced-motion variant.
- Reduced motion remains the existing `system / on / reduced / off` authority; non-essential movement is removed while state feedback remains.
