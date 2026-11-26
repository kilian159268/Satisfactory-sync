// Ersatz-Worker: läuft in das Speicher-Limit (resourceLimits).
const hog = [];
for (;;) hog.push(new Array(1e5).fill({ x: Math.random() }));
