export function summarize(samples) {
	if (!Array.isArray(samples) || samples.length === 0)
		throw new Error('at least one sample is required');
	if (samples.some((sample) => !Number.isFinite(sample) || sample < 0))
		throw new Error('samples must be non-negative finite numbers');
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	const mean = sorted.reduce((total, sample) => total + sample, 0) / sorted.length;
	const variance =
		sorted.reduce((total, sample) => total + (sample - mean) ** 2, 0) / sorted.length;
	// Nearest-rank percentiles keep the stored JSON easy to recompute and avoid
	// inventing latency values between a small beta cohort's real observations.
	const percentile = (rank) => sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)];
	return {
		samples: sorted.length,
		min: sorted[0],
		max: sorted.at(-1),
		median,
		p95: percentile(0.95),
		p99: percentile(0.99),
		mean,
		standard_deviation: Math.sqrt(variance)
	};
}

export function regressions(current, baseline, allowedFraction = 0.15) {
	const failures = [];
	for (const [metric, summary] of Object.entries(current)) {
		const prior = baseline[metric];
		if (
			!prior ||
			!Number.isFinite(summary.median) ||
			!Number.isFinite(prior.median) ||
			prior.median <= 0
		)
			continue;
		const fraction = (summary.median - prior.median) / prior.median;
		if (fraction > allowedFraction) {
			failures.push({
				metric,
				baseline_median: prior.median,
				current_median: summary.median,
				regression_fraction: fraction
			});
		}
	}
	return failures;
}
