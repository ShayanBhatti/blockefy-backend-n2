// seedGigs.js
require('dotenv').config(); // Load .env
const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');

const User = require('../models/User');      // adjust path
const Gig = require('../models/Gig');        // adjust path

// ================ CONFIGURATION ================
// Read URI from environment
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌ MONGODB_URI not set in .env');
  process.exit(1);
}

// TODO: Provide at least one valid userId (must be a seller)
// If you leave it empty, the script will fetch all sellers from the DB.
const PROVIDED_USER_IDS = [
  '6a76f4b7de344e64cda77c15', // replace with real IDs
];

// TODO: Provide an array of image URLs (gigImage)
const IMAGE_URLS = [
  
  'https://picsum.photos/id/1/800/600',
  'https://picsum.photos/id/10/800/600',
  'https://picsum.photos/id/100/800/600',
  'https://picsum.photos/id/1015/800/600',
  'https://picsum.photos/id/1018/800/600',
  'https://picsum.photos/id/102/800/600',
  'https://picsum.photos/id/1024/800/600',
  'https://picsum.photos/id/106/800/600',
  'https://picsum.photos/id/1067/800/600',
  'https://picsum.photos/id/1074/800/600',
];

const NUM_GIGS = 25;

// ================ HELPER FUNCTIONS ================
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomGig(userId, imageUrl) {
  const pricing = {
    base: faker.commerce.price({ min: 10, max: 50, dec: 0 }),
    standard: faker.commerce.price({ min: 60, max: 150, dec: 0 }),
    premium: faker.commerce.price({ min: 200, max: 500, dec: 0 }),
  };

  const status = Math.random() < 0.8 ? 'posted' : 'draft';

  const tags = faker.helpers.arrayElements(
    ['web', 'design', 'coding', 'writing', 'marketing', 'video', 'photo', 'music', 'voice', 'consulting'],
    { min: 2, max: 4 }
  );

  return {
    userId,
    gigImage: imageUrl || null,
    gigImagePublicId: null,
    title: faker.company.catchPhrase(),
    description: faker.lorem.paragraphs({ min: 2, max: 4 }),
    category: faker.helpers.arrayElement([
      'web-development',
      'graphic-design',
      'writing-translation',
      'digital-marketing',
      'video-animation',
      'music-audio',
      'programming-tech',
      'business-consulting',
    ]),
    tags,
    pricing,
    deliveryTime: randomInt(1, 7),
    status,
    createdAt: faker.date.past({ years: 1 }),
    updatedAt: new Date(),
  };
}

// ================ MAIN SEEDER ================
async function seedGigs() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    let userIds = PROVIDED_USER_IDS.filter(id => id && id.length > 0);

    if (userIds.length === 0) {
      console.log('No user IDs provided. Fetching all sellers from DB...');
      const sellers = await User.find({ role: 'seller' }).select('_id');
      userIds = sellers.map(u => u._id.toString());
      if (userIds.length === 0) {
        throw new Error('No sellers found. Create a seller user first.');
      }
      console.log(`Found ${userIds.length} seller(s).`);
    }

    const imagePool = IMAGE_URLS.length > 0 ? IMAGE_URLS : ['https://picsum.photos/seed/default/800/600'];

    const gigs = [];
    for (let i = 0; i < NUM_GIGS; i++) {
      const userId = randomItem(userIds);
      const imageUrl = randomItem(imagePool);
      gigs.push(generateRandomGig(userId, imageUrl));
    }

    const inserted = await Gig.insertMany(gigs);
    console.log(`✅ Successfully created ${inserted.length} gigs:`);
    inserted.forEach((g, idx) => {
      console.log(`  ${idx+1}. ${g.title} (${g.status}) - user: ${g.userId}`);
    });

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seedGigs();