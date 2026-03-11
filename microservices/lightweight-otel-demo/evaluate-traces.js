const axios = require('axios');
const fs = require('fs');

const JAEGER_API = 'http://localhost:16686/api';

async function fetchTraces(serviceName) {
    try {
        const response = await axios.get(`${JAEGER_API}/traces`, {
            params: {
                service: serviceName,
                lookback: '1h',
                limit: 100
            }
        });
        return response.data.data;
    } catch (error) {
        console.error(`Error fetching traces for ${serviceName}:`, error.message);
        return [];
    }
}

async function evaluate() {
    const allTraces = [];
    const services = ['gateway-service', 'auth-service', 'product-service'];

    for (const service of services) {
        const traces = await fetchTraces(service);
        for (const trace of traces) {
            if (!allTraces.find(t => t.traceID === trace.traceID)) {
                allTraces.push(trace);
            }
        }
    }

    const functionStats = new Map();

    allTraces.forEach(trace => {
        const spanServiceMap = new Map();

        trace.spans.forEach(span => {
            const process = trace.processes[span.processID];
            if (process) {
                spanServiceMap.set(span.spanID, process.serviceName);
            }
        });

        trace.spans.forEach(span => {
            const process = trace.processes[span.processID];
            if (!process) return;

            const serviceName = process.serviceName;
            const functionName = span.operationName;

            if (!functionName.startsWith('gateway-') && !functionName.startsWith('auth-') && !functionName.startsWith('product-')) {
                return;
            }

            if (!functionStats.has(functionName)) {
                functionStats.set(functionName, {
                    service: serviceName,
                    internalCalls: 0,
                    externalCalls: 0,
                    callers: new Map()
                });
            }

            const stats = functionStats.get(functionName);

            let callerService = 'external (client)';
            if (span.references && span.references.length > 0) {
                const parentRef = span.references.find(ref => ref.refType === 'CHILD_OF');
                if (parentRef) {
                    callerService = spanServiceMap.get(parentRef.spanID) || 'unknown';
                }
            }

            if (callerService === serviceName) {
                stats.internalCalls++;
            } else {
                stats.externalCalls++;
                const callerCount = stats.callers.get(callerService) || 0;
                stats.callers.set(callerService, callerCount + 1);
            }
        });
    });

    let output = `# Function Relocation Evaluation Results

Found **${allTraces.length}** unique traces spanning ${services.join(', ')}.

## Function Analysis
`;

    functionStats.forEach((stats, funcName) => {
        const totalCalls = stats.internalCalls + stats.externalCalls;
        if (totalCalls === 0) return;

        const extPercentage = Math.round((stats.externalCalls / totalCalls) * 100);

        output += `### \`${funcName}\` (Host Service: \`${stats.service}\`)\n`;
        output += `- **Total Calls:** ${totalCalls}\n`;
        output += `- **Internal Calls:** ${stats.internalCalls}\n`;
        output += `- **External Calls:** ${stats.externalCalls} (${extPercentage}%)\n`;

        if (stats.externalCalls > 0) {
            output += `- **Top External Callers:**\n`;
            stats.callers.forEach((count, caller) => {
                output += `  - \`${caller}\`: ${count} calls\n`;
            });
        }

        if (extPercentage >= 65) {
            output += `\n> [!WARNING]\n> **Misplaced function detected!**\n> \`${funcName}\` is called externally ${extPercentage}% of the time.\n`;

            let maxCaller = '';
            let maxCount = 0;
            stats.callers.forEach((count, caller) => {
                if (count > maxCount) {
                    maxCount = count;
                    maxCaller = caller;
                }
            });

            if (maxCaller && maxCaller !== 'external (client)') {
                output += `> \n> **RECOMMENDATION:** Relocate \`${funcName}\` to \`${maxCaller}\` microservice.\n\n`;
            } else {
                output += `> \n> **RECOMMENDATION:** Expose \`${funcName}\` as an edge API or integrate closer to client.\n\n`;
            }
        } else {
            output += `\n> [!NOTE]\n> **Status:** Healthy placement. Internal caller ratio is standard.\n\n`;
        }
    });

    fs.writeFileSync('C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\dd91f653-4785-4097-b52d-ed5d7e3de1fb\\evaluation_results.md', output);
    console.log('Results written to evaluation_results.md');
}

evaluate();
