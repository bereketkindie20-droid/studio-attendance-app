const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== CONFIGURATION ====================
const BOT_TOKEN = '8666684034:AAFQWq2RE65DqS86qhB3fBayrbwpzzVEEaQ';
const MANAGER_CHAT_ID = '8108017872'; // Your integrated Telegram ID
const SUPABASE_URL = 'https://hixfsxlfbblmjqhgjnio.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fbDQTPbT-MgAXBJxmTjYUA_-Bs33TSQ';

// Studio Location Coordinates (Eldasol Building 1st Floor, Mickey Leland St)
const STUDIO_LAT = 9.0095; 
const STUDIO_LON = 38.7809;
// =======================================================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Haversine Distance Calculation in Meters
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c;
}

// Check-in API Route
app.post('/api/check-in', async (req, res) => {
    try {
        const { employee_name, telegram_id, user_lat, user_lon, check_in_timestamp } = req.body;
        const distance = getDistanceFromLatLonInMeters(STUDIO_LAT, STUDIO_LON, user_lat, user_lon);

        if (distance > 100) {
            const outOfBoundsMsg = `⚠️ <b>OUT OF BOUNDS CHECK-IN</b>\n\nEmployee: <b>${employee_name}</b> attempted check-in from <b>${Math.round(distance)}m</b> away (Outside 100m zone).`;
            await bot.sendMessage(MANAGER_CHAT_ID, outOfBoundsMsg, { parse_mode: 'HTML' });
            
            await supabase.from('attendance_logs').insert([{
                telegram_id,
                employee_name,
                latitude: user_lat,
                longitude: user_lon,
                distance_meters: distance,
                status: 'OUT_OF_BOUNDS',
                minutes_late: 0
            }]);

            return res.json({ success: false, message: "You are outside the studio working area!" });
        }

        const now = new Date(check_in_timestamp);
        const expectedTime = new Date(now);
        expectedTime.setHours(8, 30, 0, 0); // 2:30 local daytime = 8:30 AM standard time

        const diffMinutes = Math.round((now - expectedTime) / (1000 * 60));
        let status = "";
        let notificationText = "";
        const currentTimeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (diffMinutes < 0) {
            status = "EARLY";
            notificationText = `🟢 <b>EARLY ARRIVAL</b>\n\nEmployee <b>${employee_name}</b> arrived earlier at <b>${currentTimeFormatted}</b>.`;
        } else if (diffMinutes <= 30) {
            status = "ON_TIME";
            notificationText = `✅ <b>ON TIME ARRIVAL</b>\n\nEmployee <b>${employee_name}</b> arrived at <b>${currentTimeFormatted}</b>.`;
        } else {
            status = "LATE";
            notificationText = `🔴 <b>LATE ARRIVAL ALERT</b>\n\nEmployee <b>${employee_name}</b> arrived at <b>${currentTimeFormatted}</b> and is <b>late by ${diffMinutes} minutes</b>!`;
        }

        await bot.sendMessage(MANAGER_CHAT_ID, notificationText, { parse_mode: 'HTML' });

        await supabase.from('attendance_logs').insert([{
            telegram_id,
            employee_name,
            latitude: user_lat,
            longitude: user_lon,
            distance_meters: distance,
            status: status,
            minutes_late: Math.max(0, diffMinutes)
        }]);

        return res.json({ success: true, status: status, minutes_late: Math.max(0, diffMinutes) });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: "Server Error" });
    }
});

// History API Route
app.get('/api/history/:telegram_id', async (req, res) => {
    const { telegram_id } = req.params;
    
    let query = supabase.from('attendance_logs').select('*').order('check_in_time', { ascending: false });
    if (telegram_id !== MANAGER_CHAT_ID) {
        query = query.eq('telegram_id', telegram_id);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
