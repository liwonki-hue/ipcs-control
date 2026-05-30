const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf-8');
const js = fs.readFileSync(path.join(__dirname, '../static/js/dashboard.js'), 'utf-8');

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable",
  url: "https://ipcs-bop-dashboard.onrender.com/"
});

dom.window.eval(`
  window.fetch = async (url) => {
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (url.includes('/api/meta')) return { units: [], systems: [] };
        if (url.includes('/api/dashboard')) return { kpi: { total_plan_di: 100 }, weekly: [], units: [], systems: [] };
        return {};
      }
    };
  };
  
  window.Chart = class Chart { 
    constructor() {} 
    static register() {}
    static defaults = { set: () => {} };
  };
  window.ChartDataLabels = {};
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  const origErr = window.console.error;
  window.console.error = (...args) => origErr("JSDOM Error:", ...args);
`);

dom.window.eval(js);
dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
