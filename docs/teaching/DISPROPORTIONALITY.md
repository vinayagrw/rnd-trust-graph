# Disproportionality analysis — PRR & ROR explained

> The safety-dossier playbook (F5) and the Radar/Conversation beats surface **PRR**, **ROR**, **χ²**,
> a **95% CI**, and a **case count** for each drug–event pair. This note explains what those numbers
> mean, how they're computed, when they count as a "signal", and — importantly — what they *don't*
> prove. Visual companion: [`safety-dossier-story.html`](./safety-dossier-story.html).

---

## 1. What problem it solves

Spontaneous-report databases (FDA FAERS, WHO VigiBase, EudraVigilance) collect millions of adverse-event
reports but have **no denominator** — you don't know how many patients took the drug, so you can't
compute a true incidence rate. **Disproportionality analysis** sidesteps that: instead of asking "how
often does this event happen?", it asks a *relative* question:

> **Is this event reported disproportionately more often for _this_ drug than for _all other_ drugs in
> the database?**

If yes, that drug–event pair is a **candidate signal** worth human investigation. It is a
**hypothesis-generating** screen, not proof of causation.

---

## 2. The 2×2 contingency table

Every measure is built from one table: the drug of interest vs. all other drugs, crossed with the
event of interest vs. all other events.

|                    | Event of interest | All other events |
|--------------------|:-----------------:|:----------------:|
| **This drug**      |     **a**         |       b          |
| **All other drugs**|       c           |       d          |

- **a** = reports naming this drug *and* this event (this is the **case count** the graph stores — e.g.
  `37` for checkpoint-inhibitor myocarditis).
- **b** = reports for this drug, some *other* event.
- **c** = reports for other drugs with this event.
- **d** = everything else.

The knowledge graph stores the **computed statistics** on a `SignalStat` node (`STAT-MYO-CPI`, …); the
raw background cells (b, c, d) live in the source PV database.

---

## 3. The two measures

### PRR — Proportional Reporting Ratio

```
PRR = [ a / (a + b) ] ÷ [ c / (c + d) ]
```

The proportion of the drug's reports that are this event, divided by the same proportion across every
other drug. **PRR = 4.2** means the event is reported ~4.2× more often (proportionally) for this drug
than for the rest of the database.

### ROR — Reporting Odds Ratio

```
ROR = ( a / b ) ÷ ( c / d )  =  (a · d) / (b · c)
```

The reporting *odds* of the event on the drug vs. off it. ROR is the measure of choice when you want to
**adjust for confounders** (age, sex, co-medication) via logistic regression, because odds ratios
compose cleanly in a regression. For rare events PRR and ROR converge; ROR runs slightly higher when
the event is concentrated in the drug's reports (which is why the demo shows e.g. myocarditis PRR 4.2
vs. ROR 4.6).

### Supporting statistics

- **χ² (chi-square, Yates-corrected)** — tests whether the association is statistically significant
  (not just noise from small counts).
- **95% CI** — the confidence interval around the estimate. A pair is only a signal if the **lower
  bound is above 1** (i.e. the interval doesn't include "no association").

---

## 4. When is it a "signal"? — common thresholds

A widely used rule (Evans et al., 2001, for PRR; EMA/MHRA practice) flags a pair when **all** of:

| Criterion | Threshold |
|-----------|-----------|
| PRR       | ≥ 2 |
| χ²        | ≥ 4 (≈ 3.84, the p<0.05 point) |
| Cases (a) | ≥ 3 |
| _or_ for ROR | 95% CI lower bound > 1 |

Below those, the association is too weak or too noisy to act on.

---

## 5. Worked example — the three demo signals

| Event | PRR | ROR | χ² | 95% CI | Cases | Signal? |
|-------|:---:|:---:|:--:|:------:|:-----:|:-------:|
| **Myocarditis** | 4.2 | 4.6 | 58.3 | 2.9–6.1 | 37 | ✅ |
| Colitis | 6.3 | 6.9 | 78.4 | 4.2–9.4 | 52 | ✅ |
| Hypothyroidism | 7.0 | 7.4 | 85.1 | 4.8–10.2 | 61 | ✅ |

All three clear every threshold — each is a statistical signal.

**The crucial nuance:** hypothyroidism and colitis have the *highest* PRR, but the dossier elevates
**myocarditis** as the priority signal. Why? Because a high PRR can be inflated by reporting bias,
notoriety bias (a known association gets over-reported), or a small denominator. The trustworthy signal
is the one with **independent corroboration** — and myocarditis is confirmed by five converging sources
in the graph: FAERS statistics, published literature, an FDA label warning, a clinical registry, and a
mechanistic entailment.

> **Disproportionality magnitude ≠ confirmation strength.** This is the single most important teaching
> point, and it's exactly why the playbook routes the conclusion to a human reviewer rather than
> auto-ranking by PRR.

---

## 6. What PRR/ROR do NOT tell you (state this plainly)

- **Not causation.** Disproportionality is hypothesis-generating. It cannot establish that the drug
  *caused* the event.
- **No incidence/risk.** There's no denominator, so you cannot say "X% of patients are affected".
- **Vulnerable to reporting artefacts.** Notoriety bias, media attention, the Weber effect (reporting
  peaks early in a product's life), and channelling all distort the numbers.
- **Sensitive to the comparator.** "All other drugs" is a crude reference; restricting to the same drug
  class changes the result.
- **Small counts are unstable.** A handful of extra reports can swing PRR dramatically — hence the χ²
  and case-count guards.

These limitations are *why* the app pairs every statistic with provenance, a mechanistic check, and
mandatory human review.

---

## 7. How the app uses it

- **Beat 1 · Radar** surfaces the signal statistics alongside data-quality flags.
- **Beat 4 · Conversation** cites the `SignalStat` nodes when it answers a signal-triage question — and
  only those the query actually returned (served-payload-only grounding).
- **F5 · Safety-dossier playbook** states the signal (with PRR/ROR), traces the mechanism, gathers the
  corroborating evidence, and routes the conclusion to a reviewer — the full narrative is in
  [`safety-dossier-story.html`](./safety-dossier-story.html).

See also: [`FEATURES_GUIDE.md`](./FEATURES_GUIDE.md) · [`DEMO_QUERIES.md`](./DEMO_QUERIES.md).

---

_References: Evans SJW, Waller PC, Davis S. "Use of proportional reporting ratios (PRRs) for signal
generation from spontaneous adverse drug reaction reports." Pharmacoepidemiol Drug Saf. 2001. ·
van Puijenbroek EP et al. "A comparison of measures of disproportionality for signal detection." 2002._
