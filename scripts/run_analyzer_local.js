const fs = require('fs');

function analyzeFunctionCalls(rawTraces){
  const NOISE_PATTERNS = [
    'health','metrics','express.middleware','middleware -','router -','corsmiddleware','fs.','net.','dns.','dns.lookup','tcp.connect','connect','readfilesync','readfile','realpathsync','statsync','lstatsync','access','expressinit','jsonparser','query','tcp','dns','fs ','net ','vfs','close','open','read','write','stat','request handler','anonymous','pg.','mongodb.','mongoose.','sequelize.','knex.'
  ];

  const functionStats = new Map();

  rawTraces.forEach(trace => {
    const spanServiceMap = new Map();
    if(!trace.spans || !Array.isArray(trace.spans)) return;

    trace.spans.forEach(span => {
      const process = trace.processes?.[span.processID];
      if(process) spanServiceMap.set(span.spanID, process.serviceName);
    });

    trace.spans.forEach(span => {
      const process = trace.processes?.[span.processID];
      if(!process) return;

      const serviceName = process.serviceName;
      const functionName = span.operationName;
      const lowerName = (functionName || '').toLowerCase();

      const isNoise = NOISE_PATTERNS.some(p => lowerName === p || lowerName.includes(p));
      const isGenericHttp = lowerName === 'http' || !!functionName.match(/^HTTP [A-Z]+$/);
      const isAppSpan = (functionName.startsWith && (functionName.startsWith('GET ') || functionName.startsWith('POST '))) || functionName.includes('-') || functionName.includes('Step') || functionName.includes('Hash') || functionName.includes('Token');

      if((isNoise || isGenericHttp) && !isAppSpan) return;

      if(!isAppSpan && !functionName.includes(' ') && functionName === functionName.toLowerCase() && functionName.length <= 3) return;

      // Accept
      const key = `${serviceName}::${functionName}`;
      if(!functionStats.has(key)){
        functionStats.set(key, { fn: functionName, service: serviceName, internalCalls:0, externalCalls:0, callers: new Map(), internalLatencies: [], externalLatencies: [] });
      }
      const stats = functionStats.get(key);

      const latencyMs = (span.duration || 0) / 1000;

      let callerService = 'external (client)';
      if(span.references && span.references.length > 0){
        const parentRef = span.references.find(r=>r.refType === 'CHILD_OF');
        if(parentRef) callerService = spanServiceMap.get(parentRef.spanID) || 'unknown';
      }

      if(callerService.includes('backstage-backend') || callerService.includes('traffic-generator') || callerService === 'unknown'){
        callerService = 'external (client)';
      }

      if(callerService === serviceName){
        stats.internalCalls++;
        stats.internalLatencies.push(latencyMs);
      } else {
        stats.externalCalls++;
        stats.externalLatencies.push(latencyMs);
        stats.callers.set(callerService, (stats.callers.get(callerService)||0)+1);
      }
    });
  });

  const results = [];
  functionStats.forEach((stats, key) => {
    const totalCalls = stats.internalCalls + stats.externalCalls;
    if(totalCalls === 0) return;
    let dominantCaller = 'none';
    let dominantCount = 0;
    stats.callers.forEach((count, caller)=>{ if(count>dominantCount){ dominantCount = count; dominantCaller = caller; }});
    const dominantPercent = totalCalls > 0 ? dominantCount / totalCalls : 0;
    const avg = arr => arr.length? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
    results.push({ functionName: stats.fn, currentService: stats.service, internalCalls: stats.internalCalls, externalCalls: stats.externalCalls, dominantCaller, dominantPercent, avgInternalLatency: avg(stats.internalLatencies), avgExternalLatency: avg(stats.externalLatencies) });
  });
  return results;
}

(async ()=>{
  const inFile = process.env.TRACES_FILE || './traces.json';
  if(!fs.existsSync(inFile)){
    console.error('Trace file not found:', inFile);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(inFile,'utf8'));
  const res = analyzeFunctionCalls(raw);
  console.log('Found', res.length, 'functions');
  res.slice(0,200).forEach(r=>{
    console.log(`- ${r.functionName} @ ${r.currentService} (internal:${r.internalCalls} external:${r.externalCalls} dominant:${Math.round(r.dominantPercent*100)}% caller:${r.dominantCaller})`);
  });
})();
