# Retro: Atlas churn model

Date: 2026-06-12

What shipped. We shipped the Atlas churn model in May 2026 at Brightline Analytics, for the subscription product's mid-market accounts. It scores every active account each Sunday night. The final model reached an AUC of 0.81 on the holdout month, a gradient-boosted model on about forty features, mostly usage trends and support history. Monthly churn fell by 9 percent in the first quarter after launch. We cannot claim all of that for the model, since pricing also changed in April, but the accounts customer success called churned noticeably less than similar accounts they did not reach.

What went wrong. Our first version looked far too good, with an AUC near 0.97. The cause was label leakage from the account_closed_at column, which the billing system fills in after a customer leaves; it had slipped into a "days since last change" feature. Finding and removing it cost us three weeks, and we had already shown the inflated number to one stakeholder, which took a careful conversation to undo.

What went right. Wei Zhang rebuilt the feature pipeline so that every feature is computed as of the scoring date, from snapshots rather than current tables, which makes leakage of this kind structurally hard. We also kept the output simple: a ranked call list for customer success every Monday, with the top three reasons for each account in plain words. They used it from week one.

Lesson. When a first result looks too good, assume leakage and go looking for it before telling anyone. Point-in-time features should be the default, not a fix.
