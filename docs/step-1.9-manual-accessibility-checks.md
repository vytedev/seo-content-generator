# Step 1.9 manual accessibility checks

Automated jsdom coverage verifies labelled decision groups, keyboard-operable native controls, disabled/read-only persisted decisions, live status announcements, and responsive class structure. It cannot prove browser layout, focus visibility, sticky-bar overlap, or zoom reflow.

Manual browser checks still required before release:

- 390, 768, 1024 and 1440 px viewports: no page-level horizontal scroll; filters and actions wrap without overlap.
- Keyboard only: traverse filters, selection, accept/reject, rationale and submit in a logical order; focus remains visibly outlined.
- 200% and 400% zoom: focused rows and rationale fields are not hidden by the sticky decision bar.
- Screen reader: severity groups, hard flags, decisions, asynchronous status and persisted rationale are announced meaningfully.

These checks were documented, not claimed as executed in this local automated pass.
