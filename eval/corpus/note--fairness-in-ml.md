# Notes on fairness in machine learning

Fairness is not one metric. Demographic parity asks that positive rates match across groups. Equalized odds asks that true positive and false positive rates match. Calibration asks that predicted probabilities mean the same thing for every group. Chouldechova's impossibility result shows you cannot satisfy all three when base rates differ.

My view: pick the metric that matches the harm. For a hiring screen, false negatives on qualified candidates from underrepresented groups are the harm I care about, so equal opportunity (matching true positive rates) is the right target. Reporting one number hides the trade-off; report the confusion matrix per group.

Related: the COMPAS debate, and the disparate impact 80 percent rule from US employment law.
