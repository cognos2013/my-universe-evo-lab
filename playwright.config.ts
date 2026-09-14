import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir:'./tests/browser',timeout:30000,workers:1,
  use:{baseURL:'http://127.0.0.1:9151',viewport:{width:1440,height:1000},headless:true,
    launchOptions:{...(existsSync(chrome)?{executablePath:chrome}:{}),args:['--enable-unsafe-swiftshader']},
    screenshot:'only-on-failure',trace:'retain-on-failure'},
  reporter:[['list'],['json',{outputFile:'reports/browser-results.json'}]],
  webServer:{command:'npm run dev -- --port 9151',url:'http://127.0.0.1:9151',reuseExistingServer:true},
});
