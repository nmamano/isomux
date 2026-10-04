# Inline diagrams

Use a visual only when it makes an important relationship easier to understand. Raw HTML supports theme variables such as `--bg-subtle`, `--border`, and `--text-primary`. Inline SVG suits small custom diagrams; use presentation attributes because scripts, event handlers, external references, `style`, and `foreignObject` are removed. A fenced Mermaid block supplies automatic layout for larger flows.

Prefer the smallest useful form: table for mappings, flow or timeline for sequence, tree for hierarchy, and wireframe for layout. Skip visuals for facts and simple actions.
