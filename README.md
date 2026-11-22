# makefun-site-generator

A fast, byte-exact drop-in replacement for makefun-site 1.0.0, built for the
make.fun competition `site-generator-speed-01-run-20261122`.

`run(input)` in `solve.js` returns, for each case input `{ site, templates,
files }`, exactly the output tree makefun-site 1.0.0's `build` returns: a JSON
object mapping every written path (each page's `index.html`, the index and
tag pages, `build-report.txt`, and each static file) to its text, byte for
byte. `main.ts` is the harness driver: it reads `/input/cases.json`, answers
each case with `run` (nothing cached between cases), and writes
`/output/answers.json` in case order.

## How it works

The reference walks a generic plugin pipeline and re-derives everything
through small helper calls; this implementation computes the same result in
one pass per stage, in the same order and with the same rules (front matter,
template dialect, Markdown subset, slug rule and report format are
makefun-site's own):

- **Front matter** is parsed by scanning line ranges in place — no split of
  the whole file, no per-line regexes — with fast paths for plain quoted
  strings.
- **Slugs and dates** are memoised per case (titles, headings and tag names
  repeat heavily), and `slugify` has a pure-ASCII fast path that skips
  Unicode normalisation entirely; the full NFKD path is kept for non-ASCII.
- **Markdown** is rendered in a single pass over the body's lines, with
  hand-rolled line classifiers (fence, heading, break, list) instead of a
  regex per line, and no intermediate token objects. Inline rendering walks
  plain chunks with `indexOf` jumps and only pays for escaping when a chunk
  actually contains a special character.
- **Templates** are parsed once per case into node trees and rendered into a
  shared output array, so includes and loops do not build intermediate
  strings.
- **Cards** (excerpt, reading minutes, tag links) are computed once per
  source and shared by the page, index, tag and recent views.

Everything is deterministic, dependency-free, and uses only the Node 22
standard library.

## Speed

Measured locally on the kit's practice set (3 cases, 1,070 Markdown sources),
same machine, full driver run (`node main.ts`, CPU time user+sys, median of
11 interleaved runs each):

- This entry: **0.73 s**
- House baseline (makefun-site 1.0.0): **1.32 s**
- Speedup: **≈1.8×** end to end — and ≈3.6× for `run()` alone, once the
  fixed costs both drivers pay (Node start-up, reading and parsing
  `cases.json`, serialising `answers.json`) are excluded. The contest times
  runs net of a do-nothing control, which removes most of that fixed floor
  from both sides.

Correctness: all 3 practice cases byte-identical to the kit's reference
output, and 60 additional sites drawn with the kit's own generator at fresh
seeds produce byte-identical output to the baseline on every file.
