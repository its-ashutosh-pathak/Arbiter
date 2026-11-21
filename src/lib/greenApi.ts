/**
 * Green API client helper for sending WhatsApp messages & files
 */

const idInstance = process.env.GREEN_API_ID_INSTANCE;
const apiTokenInstance = process.env.GREEN_API_TOKEN_INSTANCE;

export async function sendWhatsAppMessage(toPhone: string, message: string) {
  if (!idInstance || !apiTokenInstance) {
    console.warn(`[GREEN-API DISABLED] Would have sent to ${toPhone}: ${message}`);
    return;
  }

  // Format phone: ensure it has digits only and ends with @c.us
  let cleanPhone = toPhone.replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
  const chatId = `${cleanPhone}@c.us`;

  try {
    const url = `https://api.green-api.com/waInstance${idInstance}/sendMessage/${apiTokenInstance}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        message
      })
    });
    const data = await res.json();
    console.log(`GreenAPI message sent to ${chatId}:`, data);
    return data;
  } catch (error) {
    console.error(`Failed to send WhatsApp message via GreenAPI to ${chatId}:`, error);
    throw error;
  }
}

export async function sendWhatsAppFile(toPhone: string, fileUrl: string, fileName: string, caption?: string) {
  if (!idInstance || !apiTokenInstance) return;

  let cleanPhone = toPhone.replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
  const chatId = `${cleanPhone}@c.us`;

  try {
    const url = `https://api.green-api.com/waInstance${idInstance}/sendFileByUrl/${apiTokenInstance}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId,
        urlFile: fileUrl,
        fileName,
        caption: caption || ''
      })
    });
    return await res.json();
  } catch (error) {
    console.error(`Failed to send file via GreenAPI to ${chatId}:`, error);
  }
}
