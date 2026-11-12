# Theme state readability

Version 1.9.0 retains the existing artwork and palettes. This revision corrects how state colors reach the native sidebar, the particle iframe and embedded module settings.

- Sidebar hover and active states use paired palette foreground and background. Dedicated native sidebar tokens are mapped as well as the semantic panel state selectors.
- The body-portaled native settings navigation uses its own `aria-current="true"` marker. Its selected label and icon use the selected foreground, including Industrial night mode's light selection fill. Hover retains that selected pairing.
- Industrial mode hides the Si brush track before it can render or assign a light foreground. Switching a track's motion preferences must not restore stale brush text colors.
- The Si brush covers the module identity area. Favorite, enabled state and open actions remain on the ordinary palette surface, independent of brush coverage or opacity.
- Embedded settings use the active mode and a local semantic token bridge across the shadow boundary. Their button labels use the accent foreground against the accent fill. Changing mode updates an open embedded settings root too.

`scripts/qa-readability.mjs` exercises repeated family and mode switches, module selection, native sidebar hover and the actual memory settings component through the shadow portal. It records computed foreground/background values, browser errors and screenshots outside the repository. Its local API uses synthetic data and does not read a real profile.

The text contrast check follows [W3C Understanding Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), including the actual button fill rather than the surrounding page. Browser fixtures and screenshot review complement the checks; they do not establish native cold-start behavior.

With `LAUREL_QA_SETTINGS_SOURCE` pointing to an installed rc.5 settings-general client bundle outside the repository, the same script renders the host's actual SettingsPanel and CSS. It exercises selected hover, inactive hover and click navigation in all four theme/mode combinations twice. Slot data and modal focus management are synthetic; the icon outline comes from the preserved native sidebar fixture. No host source is included in the public project.


Native menu surfaces and session actions also use the active shell palette:

- The native menu material child consumes `--dsw-menu-surface-fill`; changing only the outer popup background leaves the host's translucent gray material in place. Menu surfaces, other overlays, group headings and leading icons now share the existing palette.
- Session quick actions inherit the row's live foreground, including brush paint and erase states and Industrial's light selected fill. A small backing in the existing ink-shadow pigment keeps the rightmost icon readable where the real brush feathers away. The host retains action visibility, hit rectangles, event routing and disabled states.
- `scripts/qa-native-menus.mjs` takes `LAUREL_QA_HOST` pointing at an installed host directory, loads its frontend primitives and SVG symbol registry, and renders its actual session row and model selector. It covers all six theme/mode combinations, mismatched host appearance, repeated menu open/close, archive delegation, model/effort selection, animated selection changes and shell-paint disable. Context, rows, model directory and API responses are synthetic; outputs and host hashes remain outside the repository. This does not establish native desktop cold-start acceptance.
