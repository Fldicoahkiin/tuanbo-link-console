export async function requireOutputLicense(): Promise<void> {
  await window.tbLink.requireOutputLicense();
}
