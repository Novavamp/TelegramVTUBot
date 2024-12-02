import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import pg from "pg";
import express from "express";
import crypto from 'crypto';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from "path";
import { fileURLToPath } from "url";

// Import minimist using the ES module syntax
import minimist from 'minimist';

// Get the port number from the command line's -p argument
const argv = minimist(process.argv.slice(2));
let port = argv.p || 0;

if (port == 0) {
    console.log("Port number is not specified");
    process.exit(1);
}

dotenv.config();
const app = express();
const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static("public"));
app.use(bodyParser.json()); // To parse JSON from Paystack

// VTU API details
const VTU_API_TOKEN = process.env.VTU_API_TOKEN;
const VTU_API_URL = 'https://api.mobilevtu.com/v1/LfW6KEMAY5tIZ7ZL6YkPmfmmP7sy/';

// PayStack API details
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

// PostgreSQL connection
const db = new pg.Client({
    user: process.env.DATABASE_USER,
    host: process.env.DATABASE_HOST,
    database: process.env.DATABASE_NAME,
    password: process.env.DATABASE_PASSWORD,
    port: process.env.DATABASE_PORT,
    ssl: {
        rejectUnauthorized: false, // Adjust based on your database security requirements
    },
});

db.connect();

async function cleanPhoneNumber(phoneNumber) {

    let cleanedNumber = phoneNumber.replace(/\D/g, '');

    if (cleanedNumber.startsWith('234')) {
        cleanedNumber = '0' + cleanedNumber.slice(3);
    }

    return cleanedNumber;
}

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

bot.onText(/\/start/, async (msg) => {
    const userId = msg.chat.id;
    const username = msg.chat.username || "Anonymous";

    // Add user to the database or update their username if it changes
    await db.query(
        `INSERT INTO users (telegram_id, username, email) 
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) 
         DO UPDATE SET username = EXCLUDED.username
         WHERE users.username IS DISTINCT FROM EXCLUDED.username`,
        [userId, username, `${userId}@telegram.bot`]
    );

    // Welcome message
    bot.sendMessage(
        userId,
        `👋 Welcome to the VTU Bot, ${username}!\n\n` +
        `Here are some commands to get started:\n\n` +
        `💳 /fund - Fund your wallet\n\n` +
        `📊 /balance - Check your wallet balance\n\n` +
        `📱 /airtime - Purchase airtime\n\n` +
        `📱 /data - Purchase data\n\n` +
        `ℹ️ /help - Get assistance`
    );
});

bot.onText(/\/help/, (msg) => {
    const userId = msg.chat.id;
    const support = "https://wa.me/+2348184893594";

    bot.sendMessage(
        userId,
        `ℹ️ How to Use the VTU Bot:\n\n` +
        `💳 Fund Wallet:\n` +
        `Use /fund to add money to your wallet.\n\n` +
        `📊 Check Balance:\n` +
        `Use /balance to view your wallet balance.\n\n` +
        `📱 Buy Airtime/Data:\n` +
        `Use /airtime to purchase airtime or /data for data purchase on any network.\n\n` +
        `💰 Verify funding:\n\n` +
        `Use /verify <reference> to verify your account funding.\n\n` +
        `🔗 Need more help? Contact support (${support}).`
    );
});

bot.onText(/\/balance/, async (msg) => {
    const userId = msg.chat.id;

    // Fetch user balance from database
    const result = await db.query(`SELECT balance FROM users WHERE telegram_id = $1`, [userId]);

    if (result.rows.length > 0) {
        const balance = parseInt(result.rows[0].balance);
        bot.sendMessage(userId, `💰 Your wallet balance is ₦${balance.toFixed(2)}`);
    } else {
        bot.sendMessage(userId, `⚠️ You are not registered. Please use /start to register.`);
    }
});

let awaitingPhoneNumber = true;

bot.onText(/\/airtime/, async (msg) => {
    const userId = msg.chat.id;

    // Check if user exists and has sufficient balance
    const result = await db.query(`SELECT balance FROM users WHERE telegram_id = $1`, [userId]);

    if (result.rows.length === 0) {
        return bot.sendMessage(userId, `⚠️ You are not registered. Please use /start to register.`);
    }

    // Prompt user to choose their network provider for airtime
    bot.sendMessage(
        userId,
        `📡 Choose your network provider for airtime purchase:`,
        {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "MTN", callback_data: "Airtime_MTN" }],
                    [{ text: "Airtel", callback_data: "Airtime_Airtel" }],
                    [{ text: "Glo", callback_data: "Airtime_Glo" }],
                    [{ text: "9Mobile", callback_data: "Airtime_9Mobile" }]
                ]
            }
        }
    );
});

bot.on("callback_query", async (callbackQuery) => {
    const userId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith("Airtime_")) {
        const [type, network] = data.split("_");

        bot.sendMessage(
            userId,
            `💵 Enter the amount for airtime (e.g., 500 from 100 upwards).`
        );

        bot.once("message", async (amountResponse) => {
            const amount = parseFloat(amountResponse.text.trim());

            if (isNaN(amount) || amount <= 0) {
                return bot.sendMessage(userId, `❌ Invalid amount. Please try again.`);
            }

            // Check user balance
            const balanceResult = await db.query(`SELECT balance FROM users WHERE telegram_id = $1`, [userId]);
            const balance = parseInt(balanceResult.rows[0].balance);
            if (amount > balanceResult.rows[0].balance) {
                return bot.sendMessage(userId, `❌ Insufficient balance (₦${balance.toFixed(2)}). Please fund your wallet.`);
            }

            bot.sendMessage(userId, `📞 Enter the phone number to recharge.`);

            bot.once("message", async (phoneResponse) => {
                const phone = await cleanPhoneNumber(phoneResponse.text);
                const operator = getOperator(phone);

                if (phone.length > 11) {
                    bot.sendMessage(userId,
                        `❌ Try again. Ensure the number is 11 digits and starts with "0" or "+234.`);
                    return
                } if (operator != network.toLowerCase()) {
                    bot.sendMessage(userId,
                        `❌ Check the phone network and try again!`);
                    return
                } else {

                    // Confirm purchase
                    bot.sendMessage(
                        userId,
                        `🛒 Confirm your airtime purchase:\n\n` +
                        `Network: ${network}\n` +
                        `Amount: ₦${amount}\n` +
                        `Phone: ${phone} (MAKE SURE THIS IS CORRECT)\n\n` +
                        `Reply with "yes" to confirm or "no" to cancel.`
                    );


                    bot.once("message", async (confirmResponse) => {
                        if (confirmResponse.text.trim().toLowerCase() === "yes") {
                            try {
                                // Call VTU API for airtime top-up
                                const response = await axios.post(`${VTU_API_URL}topup`,
                                    {
                                        operator: network,
                                        type: type.toLowerCase(),
                                        value: amount,
                                        phone: phone,
                                    },
                                    {
                                        headers: {
                                            "Api-Token": VTU_API_TOKEN,
                                            "Request-Id": Math.floor(Math.random() * 1_000_000),
                                            "content-type": "application/x-www-form-urlencoded",
                                        },
                                    }
                                );
                                console.log(response.data);

                                if (response.data.status === "success") {

                                    // Deduct amount and process VTU
                                    await db.query(`UPDATE users SET balance = balance - $1 WHERE telegram_id = $2`, [
                                        amount,
                                        userId,
                                    ]);

                                    bot.sendMessage(userId, `✅ Airtime purchase successful! Transaction Ref: `);
                                } else if (response.data.status === "error") {
                                    const sensitiveErrors = [
                                        "Insufficient Balance", // Include partial matches for sensitive messages
                                    ];

                                    // Check if the error message contains any of the sensitive error patterns
                                    const isSensitiveError = sensitiveErrors.some((pattern) =>
                                        response.data.message.includes(pattern)
                                    );

                                    if (isSensitiveError) {
                                        bot.sendMessage(
                                            userId,
                                            "⚠️ Airtime purchase failed. Please try again or contact support."
                                        );
                                    } else {
                                        bot.sendMessage(
                                            userId,
                                            `⚠️ Airtime purchase failed: ${response.data.message}`
                                        );
                                    }

                                    console.log(`${response.data.message}`); // Log the full error for the owner
                                }

                            } catch (error) {
                                console.error(error);
                                bot.sendMessage(
                                    userId,
                                    `❌ An error occurred while processing your request.`
                                );
                            }

                        } else {
                            bot.sendMessage(userId, `❌ Purchase canceled.`);
                        }
                    });
                }
            });
        });
    }
});

bot.onText(/\/fund/, async (msg) => {
    const userId = msg.chat.id;

    // Prompt the user to enter the amount
    bot.sendMessage(userId, "💰 Please enter the amount you want to fund:");

    // Wait for the user's amount input
    bot.once("message", async (amountResponse) => {
        const amount = parseFloat(amountResponse.text.trim());

        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(userId, "❌ Invalid amount. Please enter a valid number.");
        }

        // Create user in DB if not exists
        const user = await db.query(
            `INSERT INTO users (telegram_id, username, email) 
             VALUES ($1, $2, $3) ON CONFLICT (telegram_id) DO UPDATE SET username = $2 RETURNING id`,
            [userId, msg.chat.username, `${userId}@telegram.bot`]
        );

        // Create transaction entry
        const transaction = await db.query(
            `INSERT INTO transactions (user_id, amount, status, paystack_reference) 
             VALUES ($1, $2, 'pending', gen_random_uuid()) RETURNING *`,
            [userId, amount]
        );

        const { id, paystack_reference } = transaction.rows[0];

        // Generate Paystack payment link
        const response = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
            {
                email: `${userId}@telegram.bot`, // Use a placeholder email
                amount: amount * 100, // Convert to kobo
                reference: paystack_reference,
            },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
        );

        const paymentUrl = response.data.data.authorization_url;

        bot.sendMessage(
            userId,
            `💳 Click the link below to fund your wallet with ₦${amount}:\n${paymentUrl}`
        );
    });
});

app.post('/webhook', async (req, res) => {
    const secret = PAYSTACK_SECRET; // Replace with your Paystack secret key
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

    // Verify the request came from Paystack
    if (hash === req.headers['x-paystack-signature']) {
        const event = req.body; // Contains transaction details

        if (event.event === 'charge.success') {
            const email = event.data.customer.email;  // Adjusted to access the email correctly
            const amount = event.data.amount;
            const reference = event.data.reference; // Get the paystack_reference
            const amountInNaira = amount / 100; // Paystack sends amount in kobo

            console.log(`Payment successful for ${email}, amount: ₦${amountInNaira}, reference: ${reference}`);

            // Get the user's Telegram ID (ensure it's saved when they initiate the bot)
            const response = await db.query(`SELECT telegram_id FROM users WHERE email = $1`, [email]);
            const userId = response.rows[0]?.telegram_id;

            if (!userId) {
                console.error(`Telegram ID not found for email: ${email}`);
                return res.status(404).send('User not found');
            }

            // Update transaction and balance
            await db.query(
                `UPDATE transactions SET status = 'successful' WHERE user_id = $1 AND paystack_reference = $2`,
                [userId, reference]
            );

            // Update user balance in your database
            await updateUserBalance(email, amountInNaira);

            // Send a message to the user in the chat
            bot.sendMessage(
                userId,
                `💰 Your wallet has been credited with ₦${amountInNaira}. Transaction reference: ${reference}.`
            );
        }

        // Respond with a 200 status to acknowledge the webhook
        res.status(200).send('Webhook received and processed');
    } else {
        res.status(400).send('Invalid signature');
    }
});

async function updateUserBalance(email, amount) {
    // Use your database logic to find the user by email and update their balance
    const query = `
        UPDATE users
        SET balance = balance + $1
        WHERE email = $2
    `;
    await db.query(query, [amount, email])
        .then(() => console.log('User balance updated successfully'))
        .catch((err) => console.error('Error updating balance:', err));
}


bot.onText(/\/verify (.+)/, async (msg, match) => {
    const userId = msg.chat.id;
    const reference = match[1];

    try {
        const response = await axios.get(
            `${PAYSTACK_BASE_URL}/transaction/verify/${reference}`,
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
        );
        console.log("Payment status: ", response.data.data.status);

        if (response.data.data.status === "success") {
            const amount = response.data.data.amount / 100;

            const transaction = await db.query(
                `SELECT * FROM transactions WHERE paystack_reference = $1`,
                [reference]
            );

            if (transaction.rows.length > 0 && transaction.rows[0].status === "pending") {
                const userId = transaction.rows[0].user_id;

                // Update transaction and balance
                await db.query(`UPDATE transactions SET status = 'successful' WHERE id = $1`, [
                    transaction.rows[0].id,
                ]);
                await db.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [
                    amount,
                    userId,
                ]);

                bot.sendMessage(userId, `✅ Payment of ₦${amount} verified and added to your wallet.`);
            } else {
                bot.sendMessage(userId, "❌ Transaction already verified or invalid.");
            }
        } else {
            bot.sendMessage(userId, `❌ Payment verification failed: ${response.data.data.gateway_response}`);
        }
    } catch (error) {
        bot.sendMessage(userId, "❌ Error verifying payment. Please try again.");
    }
});

// Function to fetch data plans for a specific operator
async function fetchDataPlans(operator) {
    try {
        const response = await axios.post(`${VTU_API_URL}fetch_data_plans`,
            `operator=${operator}`,
            {
                headers: {
                    'Api-Token': VTU_API_TOKEN,
                    'Request-Id': Math.floor(Math.random() * 1_000_000),
                    'content-type': 'application/x-www-form-urlencoded',
                }
            }
        );
        awaitingPhoneNumber = true;
        return response.data.data; // Return the array of data plans
    } catch (error) {
        console.error("Error fetching data plans:", error.response ? error.response.data : error.message);
        return null;
    }
}

// Handler for the '/data' command
bot.onText(/\/data/, async (msg) => {
    const userId = msg.chat.id;

    // Ask user to choose an operator
    bot.sendMessage(userId, "Please select your network operator", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "MTN", callback_data: "MTN" }],
                [{ text: "Airtel", callback_data: "Airtel" }],
                [{ text: "Glo", callback_data: "Glo" }],
                [{ text: "9mobile", callback_data: "9mobile" }]
            ]
        }
    });
    awaitingPhoneNumber = false;
});

// Handle the user's operator selection
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.message.chat.id;
    const operator = callbackQuery.data;

    if (awaitingPhoneNumber === false) {
        // Fetch data plans based on operator
        const dataPlans = await fetchDataPlans(operator);

        if (dataPlans) {
            let plansMessage = `Please choose a data plan for ${operator}:`;

            // Ask the user to choose a data plan, displaying the correct validity for each plan
            bot.sendMessage(userId, plansMessage, {
                reply_markup: {
                    inline_keyboard: dataPlans.map((plan, index) => [{
                        // Append the correct validity (plan.validity) to each plan
                        text: `${plan.label} - ₦${plan.price} (${plan.validity} days)`,
                        callback_data: `data_${operator}_${plan.plan}_${plan.price}_${plan.validity}_${plan.label}` // Include operator, label, plan ID, price, and validity in callback_data
                    }])
                }
            });
        } else {
            bot.sendMessage(userId, "Sorry, I couldn't fetch data plans. Please try again later.");
        }
    }
});

function validatePhoneNumber(phoneNumber) {
    // Remove non-numeric characters (if any)
    phoneNumber = phoneNumber.replace(/\D/g, '');
    // Ensure the phone number is 11 digits long and starts with valid prefixes
    const validPrefixes = [
        '0803', '0806', '0703', '0903', '0906', '0806', '0706', '0813', '0810', '0814', '0816', '0913', '0916', // MTN
        '0701', '0802', '0812', '0902', '0907', '0901', '0904', '0708', '0808', // Airtel
        '0705', '0805', '0815', '0905', '0807', '0811', '0915', // Glo
        '0809', '0817', '0909', '0908', '0818' // 9mobile
    ];

    const prefix = phoneNumber.substring(0, 4); // First four digits
    return phoneNumber.length === 11 && validPrefixes.includes(prefix);
}

// Function to validate the phone number operator
function getOperator(phoneNumber) {
    if (!validatePhoneNumber(phoneNumber)) {
        return null;
    }

    const operators = {
        mtn: ['0803', '0806', '0703', '0903', '0906', '0806', '0706', '0813', '0810', '0814', '0816', '0913', '0916'],
        airtel: ['0701', '0802', '0812', '0902', '0907', '0901', '0904', '0708', '0808'],
        glo: ['0705', '0805', '0815', '0905', '0807', '0811', '0915'],
        '9mobile': ['0809', '0817', '0909', '0908', '0818']
    };

    const prefix = phoneNumber.substring(0, 4);

    for (const [operator, prefixes] of Object.entries(operators)) {
        if (prefixes.includes(prefix)) {
            return operator; // Return operator name
        }
    }
    return null; // No match
}

const userStates = {}; // To store user states

bot.on("message", async (msg) => {
    const userId = msg.chat.id;
    const text = msg.text;
    const phone = await cleanPhoneNumber(msg.text);

    // If the user is not in the flow, ignore
    if (!userStates[userId]) return;

    const userState = userStates[userId];

    switch (userState.step) {
        case "awaitingPhoneNumber":
            const operatorFromPhone = getOperator(phone);

            if (!operatorFromPhone) {
                bot.sendMessage(userId, "❌ Invalid phone number. Please enter a valid one.");
                return;
            }

            if (operatorFromPhone !== userState.operator.toLowerCase()) {
                console.log(operatorFromPhone)
                bot.sendMessage(
                    userId,
                    `❌ Phone number does not match the selected operator. Please enter a valid ${userState.operator} number.`
                );
                return;
            }

            // Save phone number and move to confirmation
            userStates[userId].phone = phone;
            userStates[userId].step = "awaitingConfirmation";

            bot.sendMessage(
                userId,
                `🛒 Confirm your Data Purchase:\n\n` +
                `Network: ${userState.operator}\n` +
                `Plan: ${userState.label}\n` +
                `Price: ₦${userState.price}\n` +
                `Validity: ${userState.validity} days\n` +
                `Phone: ${phone}\n\n` +
                `Confirm? Reply 'yes' or 'no'.`
            );
            break;

        case "awaitingConfirmation":
            if (text.toLowerCase() === "yes") {
                const balanceResult = await db.query(`SELECT balance FROM users WHERE telegram_id = $1`, [userId]);
                const balance = parseInt(balanceResult.rows[0].balance);

                if (parseInt(userState.price) > balance) {
                    bot.sendMessage(
                        userId,
                        `❌ Insufficient balance (₦${balance.toFixed(2)}). Please fund your wallet.`
                    );
                    delete userStates[userId]; // Reset user state
                    return;
                }

                // Proceed with API call
                try {
                    // Call VTU API for data top-up
                    const response = await axios.post(`${VTU_API_URL}topup`,
                        {
                            operator: userState.operator,
                            type: "data",
                            value: userState.planId,
                            phone: userState.phone,
                        },
                        {
                            headers: {
                                "Api-Token": VTU_API_TOKEN,
                                "Request-Id": Math.floor(Math.random() * 1_000_000),
                                "content-type": "application/x-www-form-urlencoded",
                            },
                        }
                    );

                    if (response.data.status === "success") {
                        await db.query(`UPDATE users SET balance = balance - $1 WHERE telegram_id = $2`, [
                            userState.price,
                            userId,
                        ]);
                        bot.sendMessage(
                            userId,
                            `🎉 Purchase successful! Phone ${userState.phone} recharged with ${userState.label}.`
                        );
                    } else if (response.data.status === "error") {
                        const sensitiveErrors = [
                            "Insufficient Balance", // Include partial matches for sensitive messages
                        ];

                        // Check if the error message contains any of the sensitive error patterns
                        const isSensitiveError = sensitiveErrors.some((pattern) =>
                            response.data.message.includes(pattern)
                        );

                        if (isSensitiveError) {
                            bot.sendMessage(
                                userId,
                                "⚠️ Data purchase failed. Please try again or contact support."
                            );
                        } else {
                            bot.sendMessage(
                                userId,
                                `⚠️ Data purchase failed: ${response.data.message}`
                            );
                        }
                        console.log(response.data); // Log the full error for the owner
                    }
                } catch (error) {
                    bot.sendMessage(userId, `❌ Error processing your request.`);
                    console.error(error);
                }

                delete userStates[userId]; // Reset user state
            } else if (text.toLowerCase() === "no") {
                bot.sendMessage(userId, `❌ Purchase cancelled.`);
                delete userStates[userId]; // Reset user state
            } else {
                bot.sendMessage(userId, `Please reply 'yes' or 'no' to confirm or cancel.`);
            }
            break;

        default:
            bot.sendMessage(userId, "❌ Unknown step. Please try again.");
            delete userStates[userId];
            break;
    }
});

// Start the flow on callback query
bot.on("callback_query", (callbackQuery) => {
    const userId = callbackQuery.message.chat.id;
    const data = callbackQuery.data.split("_");

    if (data[0] === "data") {
        userStates[userId] = {
            step: "awaitingPhoneNumber",
            operator: data[1],
            planId: data[2],
            price: parseInt(data[3]),
            validity: data[4],
            label: data[5],
        };

        bot.sendMessage(userId, "📞 Enter the phone number to recharge:");
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});