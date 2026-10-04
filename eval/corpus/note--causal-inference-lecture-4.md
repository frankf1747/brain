# DATA 6100 lecture 4: difference-in-differences

Date: 2026-09-17
DATA 6100 Causal Inference for Analysts, Professor Elena Marsh

Difference-in-differences compares how an outcome changes over time in a group that got a treatment with how it changes in a group that did not. The first difference removes stable differences between the groups; the second removes changes that hit everyone at once, like a season or a price change across the market. Her example was a minimum-wage increase in one county, with the neighbouring county as the control.

The key assumption is parallel trends: without the treatment, the two groups would have moved together. We cannot test it directly after the treatment, but we can check the pre-period. Plot both groups for several periods before the change and look for diverging slopes; an event-study version with leads and lags makes this concrete. If the lead coefficients are clearly non-zero, the design is in trouble. She also warned about staggered adoption, where groups are treated at different times and the simple two-way fixed effects estimate can be badly biased.

When no single control group is credible, synthetic control builds one: a weighted mix of untreated units chosen so that the mix tracks the treated unit closely before the treatment. The gap afterwards is the estimated effect. It works best with one or a few treated units and a long pre-period, and the weights should be shown, not hidden.

Problem set 2 is due on 2026-10-08. It asks for a pre-trend plot and one robustness check of our choice.
