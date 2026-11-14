import { createChart } from '@lumen-charts/core';

const container = document.getElementById('chart');
if (container === null) {
	throw new Error('Missing #chart element');
}

createChart(container, { background: '#0e1116' });
