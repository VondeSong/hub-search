# EvilCharts adapters for Hub

`StudyCharts.tsx` adapts EvilCharts' Recharts area reveal mask, one-shot staggered
bar growth, gradient fills and interactive chart presentation to Hub's plain CSS
and real flashcard data. Unused chart variants and shadcn/Tailwind wrappers are
omitted. Both SVG chart animation and the progress ring honor reduced motion.

Upstream: https://github.com/legions-developer/evilcharts
Revision: `500ecd44c1fdcf319ba83ea68f3771bc76125974`
Source files: `src/registry/charts/recharts-area-chart.tsx`,
`src/registry/charts/recharts-bar-chart.tsx`, `src/registry/charts/recharts-pie-chart.tsx`.

Copyright (c) 2026 Gurbinder. MIT license retained in `LICENSE`.
