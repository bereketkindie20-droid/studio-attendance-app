const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== CONFIGURATION ====================
const BOT_TOKEN = '8666684034:AAFQWq2RE65DqS86qhB3fBayrbwpzzVEEaQ';
const MANAGER_CHAT_ID = '8108017872'; // Manager Telegram ID
const SUPABASE_URL = 'https://hixfsxlfbblmjqhgjnio.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fbDQTPbT-MgAXBJxmTjYUA_-Bs33TSQ';

// Studio Location Coordinates (Eldasol Building 1st Floor, Mickey Leland St)
const STUDIO_LAT = 9.0095; 
const STUDIO_LON = 38.7809;
const MAX_ALLOWED_DISTANCE_METERS = 100;
// =======================================================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

function formatDuration(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return `${hours}h ${mins}m`;
}

// ==================== ONBOARDING & PROFILE ROUTES ====================

app.get('/api/employee/status/:telegram_id', async (req, res) => {
    try {
        const { telegram_id } = req.params;
        const { data, error } = await supabase
            .from('employees')
            .select('*')
            .eq('telegram_id', telegram_id)
            .single();

        if (error || !data) {
            return res.json({ registered: false });
        }
        return res.json({ registered: true, profile: data });
    } catch (err) {
        return res.status(500).json({ error: 'Server error checking status' });
    }
});

app.post('/api/employee/register', async (req, res) => {
    try {
        const { telegram_id, full_name, phone_number, role } = req.body;

        if (!telegram_id || !full_name || !phone_number || !role) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        const { data, error } = await supabase.from('employees').insert([{
            telegram_id,
            full_name,
            phone_number,
            role
        }]).select().single();

        if (error) throw error;

        const registrationAlert = `👤 <b>NEW EMPLOYEE REGISTERED</b>\n\n` +
            `Name: <b>${full_name}</b>\n` +
            `Role: <b>${role}</b>\n` +
            `Phone: <b>${phone_number}</b>\n` +
            `Telegram ID: <code>${telegram_id}</code>`;

        await bot.sendMessage(MANAGER_CHAT_ID, registrationAlert, { parse_mode: 'HTML' });

        return res.json({ success: true, profile: data });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Registration failed.' });
    }
});

// ==================== CHECK-IN ROUTE ====================
app.post('/api/check-in', async (req, res) => {
    try {
        const { employee_name, telegram_id, user_lat, user_lon, check_in_timestamp } = req.body;
        
        if (!user_lat || !user_lon) {
            return res.status(400).json({ success: false, message: "Invalid location coordinates provided." });
        }

        const distance = getDistanceFromLatLonInMeters(STUDIO_LAT, STUDIO_LON, user_lat, user_lon);
        const userLocationMapsUrl = `https://maps.google.com/?q=${user_lat},${user_lon}`;

        if (distance > MAX_ALLOWED_DISTANCE_METERS) {
            const outOfBoundsMsg = `⚠️ <b>OUT OF BOUNDS CHECK-IN</b>\n\n` +
                `Employee: <b>${employee_name}</b>\n` +
                `Distance: <b>${Math.round(distance)}m away</b> (Limit: ${MAX_ALLOWED_DISTANCE_METERS}m)\n` +
                `📍 <a href="${userLocationMapsUrl}">View Attempted Location on Google Maps</a>`;
            
            await bot.sendMessage(MANAGER_CHAT_ID, outOfBoundsMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
            
            await supabase.from('attendance_logs').insert([{
                telegram_id,
                employee_name,
                latitude: user_lat,
                longitude: user_lon,
                distance_meters: distance,
                status: 'OUT_OF_BOUNDS',
                minutes_late: 0
            }]);

            return res.json({ 
                success: false, 
                message: `You are outside the studio working area (${Math.round(distance)}m away)!` 
            });
        }

        const serverNow = new Date();
        const eatOffsetMs = 3 * 60 * 60 * 1000;
        const localNow = new Date(serverNow.getTime() + eatOffsetMs);

        const expectedTime = new Date(localNow);
        expectedTime.setUTCHours(8, 30, 0, 0);

        const diffMinutes = Math.round((localNow - expectedTime) / (1000 * 60));
        let status = "";
        let notificationText = "";
        const currentTimeFormatted = localNow.toISOString().substring(11, 16);

        if (diffMinutes < 0) {
            status = "EARLY";
            notificationText = `🟢 <b>EARLY ARRIVAL</b>\n\nEmployee: <b>${employee_name}</b>\nTime: <b>${currentTimeFormatted} EAT</b>\n📍 <a href="${userLocationMapsUrl}">Location Map</a>`;
        } else if (diffMinutes <= 30) {
            status = "ON_TIME";
            notificationText = `✅ <b>ON TIME ARRIVAL</b>\n\nEmployee: <b>${employee_name}</b>\nTime: <b>${currentTimeFormatted} EAT</b>\n📍 <a href="${userLocationMapsUrl}">Location Map</a>`;
        } else {
            status = "LATE";
            notificationText = `🔴 <b>LATE ARRIVAL ALERT</b>\n\nEmployee: <b>${employee_name}</b>\nTime: <b>${currentTimeFormatted} EAT</b>\nStatus: <b>Late by ${diffMinutes} minutes</b>\n📍 <a href="${userLocationMapsUrl}">Location Map</a>`;
        }

        await bot.sendMessage(MANAGER_CHAT_ID, notificationText, { parse_mode: 'HTML', disable_web_page_preview: true });

        await supabase.from('attendance_logs').insert([{
            telegram_id,
            employee_name,
            latitude: user_lat,
            longitude: user_lon,
            distance_meters: distance,
            status: status,
            minutes_late: Math.max(0, diffMinutes),
            check_in_time: new Date().toISOString()
        }]);

        return res.json({ success: true, status: status, minutes_late: Math.max(0, diffMinutes) });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==================== CHECK-OUT ROUTE ====================
app.post('/api/check-out', async (req, res) => {
    try {
        const { employee_name, telegram_id, user_lat, user_lon } = req.body;

        if (!user_lat || !user_lon) {
            return res.status(400).json({ success: false, message: "Invalid location coordinates provided." });
        }

        const distance = getDistanceFromLatLonInMeters(STUDIO_LAT, STUDIO_LON, user_lat, user_lon);
        const userLocationMapsUrl = `https://maps.google.com/?q=${user_lat},${user_lon}`;

        if (distance > MAX_ALLOWED_DISTANCE_METERS) {
            return res.json({ 
                success: false, 
                message: `You must be at the studio to check out (${Math.round(distance)}m away)!` 
            });
        }

        const { data: activeLogs, error: searchError } = await supabase
            .from('attendance_logs')
            .select('*')
            .eq('telegram_id', telegram_id)
            .is('check_out_time', null)
            .order('check_in_time', { ascending: false })
            .limit(1);

        if (searchError || !activeLogs || activeLogs.length === 0) {
            return res.json({ success: false, message: "No active check-in record found for today!" });
        }

        const activeLog = activeLogs[0];
        const checkInDate = new Date(activeLog.check_in_time);
        const checkOutDate = new Date();

        const durationMinutes = Math.max(0, Math.round((checkOutDate - checkInDate) / (1000 * 60)));
        const durationFormatted = formatDuration(durationMinutes);

        const { error: updateError } = await supabase
            .from('attendance_logs')
            .update({
                check_out_time: checkOutDate.toISOString(),
                total_minutes_worked: durationMinutes
            })
            .eq('id', activeLog.id);

        if (updateError) throw updateError;

        const serverNow = new Date();
        const localNow = new Date(serverNow.getTime() + 3 * 60 * 60 * 1000);
        const currentTimeFormatted = localNow.toISOString().substring(11, 16);

        const checkOutMsg = `🚪 <b>EMPLOYEE CHECK-OUT</b>\n\n` +
            `Employee: <b>${employee_name}</b>\n` +
            `Check-Out Time: <b>${currentTimeFormatted} EAT</b>\n` +
            `Total Duration: <b>${durationFormatted}</b>\n` +
            `📍 <a href="${userLocationMapsUrl}">Check-Out Location Map</a>`;

        await bot.sendMessage(MANAGER_CHAT_ID, checkOutMsg, { parse_mode: 'HTML', disable_web_page_preview: true });

        return res.json({ 
            success: true, 
            message: `Check-out successful! Shift duration: ${durationFormatted}`,
            duration: durationFormatted
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==================== HISTORY & ADMIN API ROUTES ====================

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

app.get('/api/admin/dashboard-data', async (req, res) => {
    try {
        const { data: logs, error: logsError } = await supabase
            .from('attendance_logs')
            .select('*')
            .order('check_in_time', { ascending: false });

        const { data: employees, error: empError } = await supabase
            .from('employees')
            .select('*');

        if (logsError || empError) throw logsError || empError;

        const activeNow = logs.filter(l => l.check_in_time && !l.check_out_time);

        return res.json({
            logs,
            employees,
            activeNow
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch admin dashboard data' });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==================== CRON JOB: MORNING ABSENCE SCAN (10:00 AM EAT) ====================
async function checkMorningAbsences() {
    try {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);

        // Fetch all registered employees
        const { data: employees, error: empError } = await supabase
            .from('employees')
            .select('*');

        if (empError || !employees || employees.length === 0) return;

        // Fetch today's check-in logs
        const { data: todayLogs, error: logError } = await supabase
            .from('attendance_logs')
            .select('telegram_id')
            .gte('check_in_time', startOfDay.toISOString());

        if (logError) throw logError;

        const checkedInIds = new Set(todayLogs.map(l => String(l.telegram_id)));
        const missingEmployees = employees.filter(e => !checkedInIds.has(String(e.telegram_id)));

        if (missingEmployees.length > 0) {
            const dateStr = new Date().toISOString().split('T')[0];
            let alertMsg = `⚠️ <b>MORNING ABSENCE / UNCHECKED ALERT (${dateStr})</b>\n\n` +
                `The following registered employees have <b>NOT checked in</b> as of 10:00 AM EAT:\n\n`;

            missingEmployees.forEach(e => {
                alertMsg += `• <b>${e.full_name}</b> (${e.role}) — 📞 <code>${e.phone_number}</code>\n`;
            });

            alertMsg += `\n<i>Please reach out to verify their status.</i>`;

            await bot.sendMessage(MANAGER_CHAT_ID, alertMsg, { parse_mode: 'HTML' });
        }
    } catch (err) {
        console.error('Error running morning absence check:', err);
    }
}

// Runs every day at 10:00 AM EAT (07:00 UTC)
cron.schedule('0 7 * * *', () => {
    console.log('Running 10:00 AM morning absence check...');
    checkMorningAbsences();
});

// ==================== CRON JOB: DAILY SUMMARY REPORT (18:00 PM EAT) ====================
async function sendDailyReport() {
    try {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);

        const { data: logs, error } = await supabase
            .from('attendance_logs')
            .select('*')
            .gte('check_in_time', startOfDay.toISOString());

        if (error) throw error;

        const total = logs.length;
        const early = logs.filter(l => l.status === 'EARLY').length;
        const onTime = logs.filter(l => l.status === 'ON_TIME').length;
        const late = logs.filter(l => l.status === 'LATE').length;
        const outOfBounds = logs.filter(l => l.status === 'OUT_OF_BOUNDS').length;

        const dateStr = new Date().toISOString().split('T')[0];

        let reportMsg = `📊 <b>DAILY ATTENDANCE SUMMARY (${dateStr})</b>\n\n` +
            `Total Check-in Attempts: <b>${total}</b>\n` +
            `🟢 Early: <b>${early}</b>\n` +
            `✅ On Time: <b>${onTime}</b>\n` +
            `🔴 Late: <b>${late}</b>\n` +
            `⚠️ Out of Bounds: <b>${outOfBounds}</b>\n\n`;

        if (logs.length > 0) {
            reportMsg += `<b>Detailed Work Hours Log:</b>\n`;
            logs.forEach(l => {
                const hoursText = l.total_minutes_worked ? formatDuration(l.total_minutes_worked) : 'Still Active';
                reportMsg += `- <b>${l.employee_name}</b>: ${l.status} | Worked: <b>${hoursText}</b>\n`;
            });
        } else {
            reportMsg += `<i>No check-ins recorded today.</i>`;
        }

        await bot.sendMessage(MANAGER_CHAT_ID, reportMsg, { parse_mode: 'HTML' });
    } catch (err) {
        console.error('Error generating daily report:', err);
    }
}

// Runs every day at 18:00 EAT (15:00 UTC)
cron.schedule('0 15 * * *', () => {
    console.log('Running daily attendance summary report...');
    sendDailyReport();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
