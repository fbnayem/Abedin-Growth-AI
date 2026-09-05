import fetch from 'node-fetch';
async function check() {
  try {
    const res = await fetch('http://localhost:3000/api/readiness');
    const data = await res.json();
    if (data.status === 'READY') {
      console.log('✅ System is ready for autonomous execution.');
      process.exit(0);
    } else {
      console.error('❌ System is NOT ready:', data);
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Readiness probe failed to connect to server.');
    process.exit(1);
  }
}
check();
