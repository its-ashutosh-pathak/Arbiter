import { supabase } from './supabase';

export async function uploadTwilioMediaToSupabase(mediaUrl: string, contractId: string): Promise<string | null> {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.warn("Twilio credentials missing. Falling back to Twilio URL.");
      return mediaUrl;
    }

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    
    // Fetch media from Twilio
    const response = await fetch(mediaUrl, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });

    if (!response.ok) {
      console.error("Failed to fetch media from Twilio:", response.statusText);
      return mediaUrl; 
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    
    // Generate a unique filename
    const ext = contentType.split('/')[1] || 'bin';
    const filename = `${contractId}/${Date.now()}.${ext}`;

    // Upload to Supabase Storage
    const { data, error } = await supabase
      .storage
      .from('revisions')
      .upload(filename, buffer, {
        contentType,
        upsert: false
      });

    if (error) {
      console.error("Failed to upload to Supabase Storage:", error);
      return mediaUrl;
    }

    // Get public URL
    const { data: publicUrlData } = supabase
      .storage
      .from('revisions')
      .getPublicUrl(filename);

    return publicUrlData.publicUrl;
  } catch (err) {
    console.error("Error in uploadTwilioMediaToSupabase:", err);
    return mediaUrl;
  }
}
