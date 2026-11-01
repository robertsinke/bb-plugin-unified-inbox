# Icon names that do not exist draw a lightning bolt

`experimental_Icon` resolves a name against the host's own vocabulary, and a name outside it
falls back to a generic glyph — a **Zap**, a lightning bolt — with no warning, no error and no
type failure, because the name is typed as `string`.

That is how this plugin shipped a filter button that looked like a lightning bolt: `Funnel` is a
lucide icon, but lucide is not the vocabulary the host resolves against. The same fallback was
hiding in `Inbox` (the filter menu's first entry) and `X` (the search clear button and the
invitation chip's ignore half).

## Choosing a name

Read the vocabulary out of the installed app instead of trusting memory of lucide:

```sh
# the registry of built-in names, in the host bundle
python3 - <<'PY'
import re
s = open('/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/'
         'bb-app/app/dist/assets/index-Bm_8408b.js', errors='ignore').read()
i = s.index('MoreHorizontal'); start = s.rindex('{', 0, i)
depth = 0
for j in range(start, len(s)):
    depth += 1 if s[j] == '{' else -1 if s[j] == '}' else 0
    if depth == 0: break
print(sorted(set(re.findall(r'([A-Z][A-Za-z0-9]{1,26})\s*:\s*[A-Za-z_$][\w$]*\s*(?=[,}])', s[start:j+1]))))
PY
```

The host also merges an extended set with its own geometry, which the `icon-extended-*.js`
chunk names. A name in either resolves; a name in neither draws the Zap.

## What was substituted, and why

| wanted | used | note |
| --- | --- | --- |
| funnel | `ListView` | the owner asked for a list/table shape; a stack of rows reads correctly |
| inbox (all conversations) | `LayoutList` | a list, distinct from the filter button's shape |
| close / ignore | `CircleX` | pairs with `CircleCheck` on the accept half |

`Rows2` was tried first and rejected by eye: it draws panelled quadrants, not rows.
