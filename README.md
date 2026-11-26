# Ricelo-Pace

A race-time prediction formula and web calculator that adjusts for weekly running mileage.

- **Calculator:** https://rictau.github.io/ricelo-pace/
- **Article:** https://rictau.github.io/ricelo-pace/article.html
- **Paper:** Preprint coming soon

Standard race calculators (like Pete Riegel's 1.06 formula) assume elite-level endurance. For recreational runners averaging 30 to 65 km/week, they predict marathon times 13 to 15 minutes too fast on average. Ricelo-Pace adds weekly mileage to the formula, works in both directions (from shorter races up to the marathon, or from a marathon down to shorter races), and keeps predictions consistent across 5K, 10K, Half Marathon, and Full Marathon.

---

## Quick Formula

Given one recent race $`(D_1, T_1)`$ and your weekly running mileage $`V`$ in km/week (multiply miles/week by 1.609344):

```math
\hat{T}_2 = T_1 \left(\frac{D_2}{D_1}\right)^{\hat{x}}, \qquad \hat{x} = 1.06 + w \cdot \max\!\big(0,\; 0.5413 - 0.1002 \ln(\max(10, V))\big)
```

For common race pairs, $`w`$ is a fixed number (the same going up or down). Here are the weights and the resulting exponent $`\hat{x}`$ at three weekly mileages:

| Race Pair | Weight $`w`$ | 40 km/wk | 80 km/wk | 120 km/wk |
| :--- | :---: | :---: | :---: | :---: |
| **HM ↔ FM** (21.1 ↔ 42.2 km) | **0.624** | 1.167 | 1.124 | 1.098 |
| **10K ↔ FM** (10 ↔ 42.2 km) | **0.380** | 1.125 | 1.099 | 1.083 |
| **5K ↔ FM** (5 ↔ 42.2 km) | **0.260** | 1.105 | 1.087 | 1.076 |
| **10K ↔ HM** (10 ↔ 21.1 km) | **0.154** | 1.086 | 1.076 | 1.069 |
| **5K ↔ HM** (5 ↔ 21.1 km) | **0.085** | 1.075 | 1.069 | 1.065 |
| **5K ↔ 10K** (5 ↔ 10 km) | **0.011** | 1.062 | 1.061 | 1.061 |

### Half Marathon to Full Marathon Shortcut

For Half-to-Full Marathon ($`D_2 / D_1 = 2`$), multiplying in $`w = 0.6239`$ gives a single line:

```math
\hat{x}_{\text{HM}\leftrightarrow\text{FM}} = 1.06 + \max\!\big(0,\; 0.3377 - 0.0625 \ln(\max(10, V))\big), \qquad \hat{T}_{\text{FM}} = T_{\text{HM}} \cdot 2^{\hat{x}_{\text{HM}\leftrightarrow\text{FM}}}
```

- **Example:** A 2:00:00 Half Marathon (120 min) at 50 km/week gives $`\hat{x} = 1.1532`$, so $`120 \times 2^{1.1532} = 266.88\text{ min}`$ = **4:26:53**.
- **Excel / Google Sheets:**
  ```excel
  =A2 * 2^(1.06 + MAX(0, 0.3377 - 0.0625 * LN(MAX(10, B2))))
  ```
  (`A2` = Half Marathon time, `B2` = weekly mileage in km/week.)

---

## General Formula (Any Distance Pair)

For any two distances $`D_1, D_2 \gt 0`$ (such as 8K, 15K, 10 mile, or 30K), the weight $`w(D_1, D_2)`$ comes from three constants fitted on US runner data ($`b_0 = 0.5413`$, $`b_1 = 0.1002`$, $`\gamma = 2.8427`$):

```math
u(D) = \mathrm{clip}\!\left(\frac{\ln(D / 5\text{ km})}{\ln(42.195 / 5)},\; 0,\; 1\right), \qquad \Psi(D;\,\gamma) = \begin{cases} 0 & D \le 5\text{ km} \\ \dfrac{\ln(42.195 / 5)}{\gamma + 1}\, u(D)^{\gamma + 1} & 5\text{ km} \lt D \lt 42.195\text{ km} \\ \dfrac{\ln(42.195 / 5)}{\gamma + 1} + \ln\!\left(\dfrac{D}{42.195\text{ km}}\right) & D \ge 42.195\text{ km} \end{cases}
```

```math
w(D_1, D_2;\,\gamma) = \frac{\Psi(D_2;\,\gamma) - \Psi(D_1;\,\gamma)}{\ln(D_2 / D_1)}
```

Built-in properties for any positive distances and weekly mileage:
- **1.06 floor:** The exponent never drops below Riegel's 1.06, even at very high mileage, so a longer race is never predicted at a faster pace than a shorter one.
- **Diminishing returns:** Higher mileage lowers the exponent smoothly along $`-\ln V`$ without needing a hard mileage cap.
- **Works both ways:** Converting $`D_1 \to D_2`$ and $`D_2 \to D_1`$ uses the exact same exponent.
- **No contradictions across distances:** Converting 5K → HM → FM gives the exact same marathon time as going straight from 5K → FM.

---

## Running the Code

Requires Node.js 18 or newer, with no packages to install (built-in Node modules only).

### Run tests

```bash
node --test tests/reproduceUsBenchmark.test.js
```

### Reproduce the US benchmark

Download the public-domain (CC0) dataset from Vickers & Vertosick (2016):
- Paper: Vickers, A. J., & Vertosick, E. A. (2016). *BMC Sports Science, Medicine and Rehabilitation*, 8(1), 26. https://doi.org/10.1186/s13102-016-0052-y
- Dataset: Figshare article 4442066 (`13102_2016_52_MOESM2_ESM.xlsx`, MD5 `1357a14b7a78f5cad3dc9108f148dc06`)

Then run:

```bash
node scripts/reproduceUsBenchmark.js \
  --file=/path/to/13102_2016_52_MOESM2_ESM.xlsx \
  --boot=10000
```

Add `--json` for JSON output instead of Markdown.

### Regenerate the figures

```bash
node scripts/generatePaperFigures.js
```

## Files

```text
.
├── CITATION.cff                      # Citation metadata
├── LICENSE                           # MIT (code) and CC BY 4.0 (figures)
├── package.json                      # No external dependencies
├── docs/                             # Web calculator and article (GitHub Pages)
├── figures/                          # SVG charts (fig1..fig7.svg)
├── scripts/
│   ├── reproduceUsBenchmark.js       # US model fitting and benchmark script
│   └── generatePaperFigures.js       # SVG chart generator
└── tests/
    └── reproduceUsBenchmark.test.js  # Unit and formula checks
```

## Data Privacy

Raw GPS watch logs, member names, and race dates from the Indonesian running club validation are kept private and are not included in this repository.

## License

- Code and web calculator (`docs/`, `scripts/`, `tests/`): [MIT License](./LICENSE)
- Figures (`figures/`): [CC BY 4.0](./LICENSE)
