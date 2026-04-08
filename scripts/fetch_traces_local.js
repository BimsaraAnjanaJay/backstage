const axios = require('axios');
const fs = require('fs');

const JAEGER_API = process.env.JAEGER_API || 'http://localhost:16686/api';
const OUT = process.env.OUT || './traces.json';
const SERVICES = (process.env.SERVICES || 'gateway-service,auth-service,product-service').split(',').map(s=>s.trim()).filter(Boolean);

async function fetchTraces(serviceName) {
  try {
    const response = await axios.get(`${JAEGER_API}/traces`, {
      params: {
        service: serviceName,
        lookback: '1h',
        limit: 100
      }
    });
    return response.data.data || [];
  } catch (error) {
    console.error(`Error fetching traces for ${serviceName}:`, error.message);
    return [];
  }
}

async function main(){
  const allTraces = [];
  for(const s of SERVICES){
    const traces = await fetchTraces(s);
    for(const t of traces){
      if(!allTraces.find(x=>x.traceID === t.traceID)) allTraces.push(t);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(allTraces, null, 2));
  console.log(`Wrote ${allTraces.length} traces to ${OUT}`);
}

main().catch(err=>{console.error(err); process.exit(1);});
