// render-start.js
const puppeteer = require('puppeteer');

async function checkPuppeteerAndStart() {
  try {
    console.log('🔧 Checking Puppeteer Chrome installation...');
    
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });
    
    console.log('✅ Puppeteer Chrome check passed!');
    await browser.close();
    
    // Start the main application
    require('./index.js');
    
  } catch (error) {
    console.error('❌ Puppeteer Chrome check failed:', error.message);
    console.log('🔄 Chrome not found, but continuing with app startup...');
    
    // Start the app anyway - Chrome should be installed via postinstall
    require('./index.js');
  }
}

checkPuppeteerAndStart();