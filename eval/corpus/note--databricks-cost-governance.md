---
author: other
---
# What a runaway Databricks bill taught me about cost governance

By Morgan Reyes, head of data platform

When we finished migrating to Databricks I expected our compute spend to fall. Three months later the invoice had nearly quadrupled, from about $41,000 a month to $157,000, and the first person to notice was someone in finance.

The causes were boring. Each squad created its own interactive cluster and nobody shut them down at the end of the day. Autoscaling had no ceiling, so a single bad join could grab two hundred workers. And because no cluster carried a team tag, I had no way to say who was spending what.

My advice to anyone starting out: write cluster policies before the first job runs, give every pool a hard worker limit, make idle clusters terminate after 20 minutes, and refuse to launch anything without a cost-center tag. Then look at the billing dashboard together every week.

I have built data platforms for close to a decade, and nothing else has cost my employer as much to learn. Treat cost governance as part of the platform, not an afterthought.
