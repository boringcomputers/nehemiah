import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { regressions, summarize } from '../src/stats.mjs';

describe('benchmark statistics', () => {
	it('reports min/max/median/mean/population standard deviation', () => {
		assert.deepEqual(summarize([4, 1, 3, 2]), {
			samples: 4,
			min: 1,
			max: 4,
			median: 2.5,
			p95: 4,
			p99: 4,
			mean: 2.5,
			standard_deviation: Math.sqrt(1.25)
		});
	});

	it('fails only material median regressions', () => {
		const failures = regressions(
			{ boot: summarize([120, 120, 120]), exec: summarize([100, 100, 100]) },
			{ boot: summarize([100, 100, 100]), exec: summarize([100, 100, 100]) },
			0.15
		);
		assert.equal(failures.length, 1);
		assert.equal(failures[0].metric, 'boot');
	});
});
