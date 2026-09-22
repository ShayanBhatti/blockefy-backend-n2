/**
 * seedUsers.js
 * Seeds 19 test users for the web3 / hardhat transaction flow:
 *   - 1  admin   (wallet Account #0)
 *   - 9  sellers (wallets Account #1  -> #9)
 *   - 9  clients (wallets Account #10 -> #18)
 * Account #19 is left unused as a spare.
 *
 * All wallets are the publicly-known hardhat local-network accounts, so this
 * is strictly for local development/testing. NEVER run against a live network.
 *
 * Credentials:
 *   email    -> <key>@blockefy.com   (key = lowercased distinctive part of the name)
 *   password -> <key>123
 *
 * Image placeholders:
 *   Avatar + profile.avatar           -> https://picsum.photos/seed/<key>-avatar/400/400
 *   Cover  + coverImage               -> https://picsum.photos/seed/<key>-cover/1200/400
 *   Portfolio thumbnails              -> https://picsum.photos/seed/<key>-work-<n>/800/600
 *   Replace these with real Cloudinary URLs when production assets are ready
 *   (keep profile.avatar + profileImage.url pointing at the same image).
 *
 * Usage (from backend root):
 *   MONGODB_URI=<uri> node src/seeders/seedUsers.js          # upsert (idempotent)
 *   node src/seeders/seedUsers.js --fresh                    # delete these 19 emails first, then re-create
 *   node src/seeders/seedUsers.js --dry-run                  # validate config + uniqueness only, write nothing
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

// =============================================================================
// CONFIGURATION
// =============================================================================
const MONGO_URI = process.env.MONGODB_URI;

// Publicly-known hardhat local network accounts (#0 -> #19).
const WALLETS = [
  { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", privateKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
  { address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", privateKey: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" },
  { address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", privateKey: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
  { address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", privateKey: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" },
  { address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", privateKey: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" },
  { address: "0xBcd4042DE499D14e55001CcbB24a551F3b954096", privateKey: "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897" },
  { address: "0x71bE63f3384f5fb98995898A86B02Fb2426c5788", privateKey: "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82" },
  { address: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a", privateKey: "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1" },
  { address: "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec", privateKey: "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd" },
  { address: "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097", privateKey: "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa" },
  { address: "0xcd3B766CCDd6AE721141F452C550Ca635964ce71", privateKey: "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61" },
  { address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30", privateKey: "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0" },
  { address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E", privateKey: "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd" },
  { address: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0", privateKey: "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0" },
  { address: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199", privateKey: "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e" },
];

/** Per-user image placeholders (swap in real Cloudinary URLs later). */
const img = {
  avatar: (key) => `https://picsum.photos/seed/${key}-avatar/400/400`,
  cover: (key) => `https://picsum.photos/seed/${key}-cover/1200/400`,
  work: (key, n) => `https://picsum.photos/seed/${key}-work-${n}/800/600`,
};

// =============================================================================
// USER DATA
// =============================================================================

/** 9 sellers. Headlines / roles come from the requested name list. */
const SELLERS = [
  {
    key: "shayan",
    fullName: "Muhammad Shayan",
    headline: "Full Stack Developer world class problem solver",
    tagline: "MERN / Next.js architect who ships reliable products, end to end.",
    bio: "Full stack developer with 8+ years building scalable web apps used by thousands. I own the problem from first call to production deploy.",
    skills: ["React", "Node.js", "MongoDB", "TypeScript", "Next.js", "AWS"],
    experience: [
      {
        title: "Senior Full Stack Developer",
        company: "DevCraft Solutions",
        startDate: new Date("2019-03-01"),
        endDate: new Date("2024-01-01"),
        description: "Led a team of 6 building enterprise React + Node platforms; cut P95 latency by 40%.",
      },
      {
        title: "Full Stack Developer",
        company: "TechNova",
        startDate: new Date("2016-01-01"),
        endDate: new Date("2019-02-01"),
        description: "Built and maintained customer-facing dashboards and payment integrations.",
      },
    ],
    education: [
      { school: "FAST-NUCES", degree: "BS Computer Science", startYear: 2012, endYear: 2016 },
    ],
    portfolio: [
      {
        title: "E-commerce Platform",
        description: "Multi-vendor marketplace with escrow payments and real-time chat.",
        image: img.work("shayan", 1),
        link: "https://github.com/ShayanBhatti",
      },
      {
        title: "SaaS Admin Dashboard",
        description: "White-label analytics dashboard with role-based access control.",
        image: img.work("shayan", 2),
        link: "https://github.com/ShayanBhatti",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "ahmed",
    fullName: "Mushaf Ahmed",
    headline: "Data Scientist",
    tagline: "Turning raw data into forecasts, dashboards and ML products.",
    bio: "Data scientist who designs end-to-end ML pipelines and turns messy data into decisions.",
    skills: ["Python", "TensorFlow", "SQL", "Pandas", "Machine Learning", "Power BI"],
    experience: [
      {
        title: "Data Scientist",
        company: "Insight Labs",
        startDate: new Date("2021-02-01"),
        endDate: null,
        description: "Built churn prediction and demand forecasting models for retail clients.",
      },
      {
        title: "Data Analyst",
        company: "Metrics Co",
        startDate: new Date("2018-06-01"),
        endDate: new Date("2021-01-01"),
        description: "Automated weekly reporting and wrote ad-hoc SQL analyses for leadership.",
      },
    ],
    education: [
      { school: "NUST", degree: "MS Data Science", startYear: 2016, endYear: 2018 },
      { school: "UET Lahore", degree: "BS Electrical Engineering", startYear: 2012, endYear: 2016 },
    ],
    portfolio: [
      {
        title: "Churn Prediction Model",
        description: "XGBoost classifier with SHAP explainability, deployed on FastAPI.",
        image: img.work("ahmed", 1),
        link: "https://github.com/ahmed",
      },
      {
        title: "Retail BI Dashboard",
        description: "Live Power BI suite used daily by 3 regional sales teams.",
        image: img.work("ahmed", 2),
        link: "https://github.com/ahmed",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "irfan",
    fullName: "Maryam Irfan",
    headline: "Content Writer",
    tagline: "SEO-driven blog posts and web copy that rank and convert.",
    bio: "Content writer specializing in long-form SEO articles, landing pages and brand voice guides.",
    skills: ["SEO", "Copywriting", "Blogging", "Keyword Research", "Editing"],
    experience: [
      {
        title: "Content Writer",
        company: "WordCraft Agency",
        startDate: new Date("2020-06-01"),
        endDate: null,
        description: "Publish 8+ SEO articles monthly for SaaS and fintech clients.",
      },
      {
        title: "Freelance Writer",
        company: "Self-employed",
        startDate: new Date("2017-01-01"),
        endDate: new Date("2020-05-01"),
        description: "Wrote web copy and case studies for 30+ small businesses.",
      },
    ],
    education: [
      { school: "Punjab University", degree: "BA English Literature", startYear: 2014, endYear: 2017 },
    ],
    portfolio: [
      {
        title: "SEO Blog — SaaS",
        description: "30k monthly organic visits within 9 months.",
        image: img.work("irfan", 1),
        link: "https://example.com/seo-blog",
      },
      {
        title: "Landing Page Copy",
        description: "Conversion copy for a fintech launch, +18% signups.",
        image: img.work("irfan", 2),
        link: "https://example.com/landing",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "yousuf",
    fullName: "Maryam Yousuf",
    headline: "Business Analyst",
    tagline: "Bridging business goals and engineering with clear requirements.",
    bio: "Business analyst with a track record of scoping, documenting and delivering cross-team projects on time.",
    skills: ["Requirements Analysis", "SQL", "Agile", "Process Mapping", "Data Analysis"],
    experience: [
      {
        title: "Business Analyst",
        company: "Nexus Consulting",
        startDate: new Date("2021-04-01"),
        endDate: null,
        description: "Owned requirements for a core banking migration across 4 squads.",
      },
      {
        title: "Junior Analyst",
        company: "DataBridge",
        startDate: new Date("2019-06-01"),
        endDate: new Date("2021-03-01"),
        description: "Documented workflows and produced requirement specs for supply-chain tools.",
      },
    ],
    education: [
      { school: "LUMS", degree: "MBA", startYear: 2017, endYear: 2019 },
      { school: "GCU Lahore", degree: "BSc Economics", startYear: 2013, endYear: 2017 },
    ],
    portfolio: [
      {
        title: "Banking Migration Spec",
        description: "End-to-end requirements pack adopted by 4 delivery squads.",
        image: img.work("yousuf", 1),
        link: "https://example.com/migration-spec",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "chaudhry",
    fullName: "Umair Chaudhry",
    headline: "AI Agent Developer",
    tagline: "Building autonomous AI agents and RAG systems with production-grade reliability.",
    bio: "AI engineer focused on LLM agents, retrieval pipelines and evaluation harnesses.",
    skills: ["LangChain", "Python", "OpenAI API", "RAG", "Prompt Engineering", "FastAPI"],
    experience: [
      {
        title: "AI Engineer",
        company: "AgentWorks",
        startDate: new Date("2022-05-01"),
        endDate: null,
        description: "Shipped customer-support agents that resolve 60% of tickets without a human.",
      },
      {
        title: "Software Engineer",
        company: "CloudNine",
        startDate: new Date("2019-08-01"),
        endDate: new Date("2022-04-01"),
        description: "Built APIs and ETL pipelines on Node/Python before specializing in AI.",
      },
    ],
    education: [
      { school: "COMSATS", degree: "BS Computer Science", startYear: 2015, endYear: 2019 },
    ],
    portfolio: [
      {
        title: "RAG Support Bot",
        description: "LangChain agent grounded on 12k docs with eval suite and tracing.",
        image: img.work("chaudhry", 1),
        link: "https://github.com/chaudhry",
      },
      {
        title: "Auto-Researcher Agent",
        description: "Multi-step research agent with tool use and memory.",
        image: img.work("chaudhry", 2),
        link: "https://github.com/chaudhry",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "usama",
    fullName: "Usama",
    headline: "Content Writer",
    tagline: "Clear, researched technical content that developers actually read.",
    bio: "Technical content writer creating docs, tutorials and scripts for dev tools and web3 products.",
    skills: ["Technical Writing", "SEO", "Scriptwriting", "Research"],
    experience: [
      {
        title: "Technical Writer",
        company: "DocuKit",
        startDate: new Date("2021-03-01"),
        endDate: null,
        description: "Author of API docs and tutorials read by 40k developers a month.",
      },
      {
        title: "Freelance Writer",
        company: "Self-employed",
        startDate: new Date("2018-01-01"),
        endDate: new Date("2021-02-01"),
        description: "Wrote scripts and articles for YouTube tech channels and startups.",
      },
    ],
    education: [
      { school: "BZU Multan", degree: "BS Software Engineering", startYear: 2014, endYear: 2018 },
    ],
    portfolio: [
      {
        title: "API Integration Guide",
        description: "Step-by-step guide covering auth, webhooks and error handling.",
        image: img.work("usama", 1),
        link: "https://example.com/api-guide",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "taqweemulhaq",
    fullName: "Taqweemulhaq",
    headline: "Sales Lead",
    tagline: "Outbound sales engine for B2B services and products.",
    bio: "Sales lead who builds pipelines from cold outreach to signed contracts, with strong CRM hygiene.",
    skills: ["Sales Strategy", "CRM", "Lead Generation", "Negotiation", "Cold Outreach"],
    experience: [
      {
        title: "Sales Lead",
        company: "Velocity Sales",
        startDate: new Date("2020-09-01"),
        endDate: null,
        description: "Grew pipeline 3x and led a team of 5 SDRs in SaaS outbound.",
      },
      {
        title: "Account Executive",
        company: "GrowthHub",
        startDate: new Date("2018-02-01"),
        endDate: new Date("2020-08-01"),
        description: "Closed $1.2M in ARR across 24 enterprise accounts.",
      },
    ],
    education: [
      { school: "IBA Karachi", degree: "BBA Marketing", startYear: 2014, endYear: 2018 },
    ],
    portfolio: [
      {
        title: "SaaS Cold Outreach Playbook",
        description: "3-channel playbook tested across 50k prospects.",
        image: img.work("taqweemulhaq", 1),
        link: "https://example.com/playbook",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "khan",
    fullName: "Ayesha Khan",
    headline: "UI/UX Designer",
    tagline: "Designing intuitive interfaces that users love and teams can ship.",
    bio: "Product designer crafting design systems, wireframes and high-fidelity prototypes for web and mobile.",
    skills: ["Figma", "Wireframing", "Prototyping", "Design Systems", "User Research"],
    experience: [
      {
        title: "Product Designer",
        company: "Palette Studio",
        startDate: new Date("2021-01-01"),
        endDate: null,
        description: "Owned the design system used across 12 client products.",
      },
      {
        title: "UI Designer",
        company: "PixelCraft",
        startDate: new Date("2018-06-01"),
        endDate: new Date("2020-12-01"),
        description: "Delivered responsive UI kits and marketing site designs.",
      },
    ],
    education: [
      { school: "NCA Lahore", degree: "BDes Visual Communication", startYear: 2014, endYear: 2018 },
    ],
    portfolio: [
      {
        title: "Fintech App Redesign",
        description: "Redesigned onboarding, +32% activation after release.",
        image: img.work("khan", 1),
        link: "https://dribbble.com/khan",
      },
      {
        title: "Design System",
        description: "Tokenized Figma library with 200+ components.",
        image: img.work("khan", 2),
        link: "https://dribbble.com/khan",
      },
    ],
    languages: ["English", "Urdu"],
  },
  {
    key: "ali",
    fullName: "Hamza Ali",
    headline: "Blockchain Developer",
    tagline: "Smart contracts, dApps and token engineering on EVM chains.",
    bio: "Blockchain developer specializing in Solidity, security review and web3 UX.",
    skills: ["Solidity", "Smart Contracts", "Web3.js", "Hardhat", "Ethereum", "IPFS"],
    experience: [
      {
        title: "Blockchain Developer",
        company: "ChainForge",
        startDate: new Date("2021-07-01"),
        endDate: null,
        description: "Developed and audited escrow + NFT contracts deployed to testnets.",
      },
      {
        title: "Full Stack Developer",
        company: "OpenLedger",
        startDate: new Date("2018-05-01"),
        endDate: new Date("2021-06-01"),
        description: "Built the dApp frontend and backend for an options marketplace.",
      },
    ],
    education: [
      { school: "FAST-NUCES", degree: "BS Computer Science", startYear: 2014, endYear: 2018 },
    ],
    portfolio: [
      {
        title: "Escrow Contract",
        description: "Multi-sig escrow with milestones, tested with hardhat + foundry.",
        image: img.work("ali", 1),
        link: "https://github.com/ali",
      },
      {
        title: "W3E Marketplace dApp",
        description: "React + ethers frontend for a token-based gig marketplace.",
        image: img.work("ali", 2),
        link: "https://github.com/ali",
      },
    ],
    languages: ["English", "Urdu"],
  },
];

/** 9 clients with buyer profiles. */
const CLIENTS = [
  {
    key: "raza",
    fullName: "Ali Raza",
    headline: "Startup Founder",
    tagline: "Building an AI-powered property analytics startup.",
    company: "Raza Ventures",
    interests: ["Real Estate", "Tech Startups", "E-commerce"],
    budgetRange: { min: 5000, max: 20000 },
    preferredCategories: ["web-development", "programming-tech"],
  },
  {
    key: "siddiqui",
    fullName: "Sara Siddiqui",
    headline: "Marketing Agency Owner",
    tagline: "Full-funnel marketing for direct-to-consumer brands.",
    company: "Siddiqui Marketing Co",
    interests: ["Digital Marketing", "Branding", "Content"],
    budgetRange: { min: 1000, max: 5000 },
    preferredCategories: ["digital-marketing", "writing-translation"],
  },
  {
    key: "hussain",
    fullName: "Bilal Hussain",
    headline: "E-commerce Entrepreneur",
    tagline: "Scaling an online retail brand across 3 markets.",
    company: "Hussain Retail",
    interests: ["E-commerce", "Dropshipping", "Supply Chain"],
    budgetRange: { min: 2000, max: 8000 },
    preferredCategories: ["graphic-design", "web-development"],
  },
  {
    key: "abbas",
    fullName: "Zainab Abbas",
    headline: "Fintech Product Manager",
    tagline: "Shipping payment products for emerging markets.",
    company: "FinPay",
    interests: ["Fintech", "Payments", "Mobile Apps"],
    budgetRange: { min: 10000, max: 40000 },
    preferredCategories: ["programming-tech", "web-development"],
  },
  {
    key: "mahmood",
    fullName: "Hassan Mahmood",
    headline: "Real Estate Developer",
    tagline: "Residential and commercial developments in Lahore.",
    company: "Mahmood Properties",
    interests: ["Real Estate", "Architecture", "Construction"],
    budgetRange: { min: 15000, max: 60000 },
    preferredCategories: ["video-animation", "business-consulting"],
  },
  {
    key: "fatima",
    fullName: "Noor Fatima",
    headline: "NFT & Digital Art Collector",
    tagline: "Curating digital art and collecting on-chain NFTs.",
    company: "Noor Art Gallery",
    interests: ["NFT", "Digital Art", "Crypto"],
    budgetRange: { min: 500, max: 3000 },
    preferredCategories: ["graphic-design", "writing-translation"],
  },
  {
    key: "karim",
    fullName: "Ahmed Karim",
    headline: "SaaS Founder",
    tagline: "Bootstrapping an analytics platform for support teams.",
    company: "Karim Cloud",
    interests: ["SaaS", "Cloud", "B2B Software"],
    budgetRange: { min: 8000, max: 30000 },
    preferredCategories: ["web-development", "programming-tech", "business-consulting"],
  },
  {
    key: "shah",
    fullName: "Hira Shah",
    headline: "Digital Marketing Manager",
    tagline: "Performance marketing across social and search.",
    company: "Bright Media",
    interests: ["Branding", "Social Media", "PPC"],
    budgetRange: { min: 1500, max: 6000 },
    preferredCategories: ["digital-marketing", "video-animation"],
  },
  {
    key: "tariq",
    fullName: "Usman Tariq",
    headline: "Video Production House Owner",
    tagline: "Commercials and corporate videos for Pakistani brands.",
    company: "Tariq Studios",
    interests: ["Video Production", "Direction", "Editing"],
    budgetRange: { min: 3000, max: 12000 },
    preferredCategories: ["video-animation", "music-audio"],
  },
];

// =============================================================================
// HELPERS
// =============================================================================
const ADMIN_WALLET_INDEX = 0;
const SELLER_WALLET_START = 1;
const CLIENT_WALLET_START = 10;
const SPARE_WALLET_START = 19;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Distinctive last word of the name -> email key + username + password root. */
function nameKey(fullName, fallback) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return (fallback || "user").toLowerCase();
  // Single word names ("Usama") use it as-is; multi-word use the last (surname).
  const word = parts.length === 1 ? parts[0] : parts[parts.length - 1];
  return word.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function pickWallet(index) {
  const wallet = WALLETS[index];
  if (!wallet) throw new Error(`Wallet index ${index} out of range`);
  if (!ADDRESS_RE.test(wallet.address)) {
    throw new Error(`Invalid hardhat address at index ${index}: ${wallet.address}`);
  }
  if (!wallet.privateKey || !/^0x[a-fA-F0-9]{64}$/.test(wallet.privateKey)) {
    throw new Error(`Invalid private key at index ${index}`);
  }
  return {
    address: wallet.address.toLowerCase(),
    privateKey: wallet.privateKey,
  };
}

/** Shared identity/auth fields (valid for email + wallet login). */
function baseIdentity({ role, key, fullName, wallet }) {
  return {
    email: `${key}@blockefy.com`,
    fullName,
    username: key,
    role,
    walletAddress: wallet.address,
    walletPrivateKey: wallet.privateKey,
    authProvider: "email",
    authProviders: {
      email: { connected: true, connectedAt: new Date() },
      google: { connected: false, googleId: null, connectedAt: null },
      github: { connected: false, githubId: null, connectedAt: null },
      wallet: { connected: true, walletAddress: wallet.address, connectedAt: new Date() },
    },
    // Bypass onboarding / OTP for realistic, instantly-usable test accounts.
    onboardingStep: 6,
    onboardingCompleted: true,
    completedSteps: [1, 2, 3, 4, 5, 6],
    emailVerified: true,
    phoneVerified: true,
    isPhoneVerified: true,
    isIdVerified: true,
    isSuspended: false,
  };
}

/** Profile payload shared by every seeded user. */
function profilePayload(key, { headline, tagline, about }) {
  const avatarUrl = img.avatar(key);
  const coverUrl = img.cover(key);
  return {
    profileImage: { url: avatarUrl, publicId: null },
    coverImage: { url: coverUrl, publicId: null },
    profile: {
      avatar: avatarUrl,
      coverPhoto: coverUrl,
      headline,
      tagline,
      about,
    },
  };
}

function sellerData(seller, wallet) {
  const { key, fullName, headline, tagline, bio, skills, experience, education, portfolio, languages } = seller;
  return {
    ...baseIdentity({ role: "seller", key, fullName, wallet }),
    ...profilePayload(key, { headline, tagline, about: bio }),
    description: bio,
    sellerProfile: {
      bio,
      skills,
      experience,
      education,
      portfolio,
      languages,
    },
  };
}

function clientData(client, wallet) {
  const { key, fullName, headline, tagline, company, interests, budgetRange, preferredCategories } = client;
  const about = `I post projects on Blockefy from ${company}.`;
  return {
    ...baseIdentity({ role: "buyer", key, fullName, wallet }),
    ...profilePayload(key, { headline, tagline, about }),
    description: about,
    buyerProfile: { company, interests, budgetRange, preferredCategories },
  };
}

/**
 * A temporary per-user phone. Not unique in the schema; just distinct + valid.
 */
function makePhone(index) {
  const n = String(index + 1).padStart(4, "0");
  return `+1 555-01${n}`;
}

async function buildUsers() {
  const users = [];

  // Admin
  const adminWallet = pickWallet(ADMIN_WALLET_INDEX);
  const adminKey = "admin";
  users.push({
    ...baseIdentity({ role: "admin", key: adminKey, fullName: "Blockefy Admin", wallet: adminWallet }),
    ...profilePayload(adminKey, {
      headline: "Blockefy Platform Admin",
      tagline: "Keeping Blockefy safe, fair and running.",
      about: "Administrator of the Blockefy decentralized freelance marketplace. Responsible for moderation, disputes and platform operations.",
    }),
    description: "Blockefy platform administrator.",
  });

  // Sellers (wallet indexes 1..9)
  SELLERS.forEach((seller, i) => {
    users.push(
      sellerData(seller, pickWallet(SELLER_WALLET_START + i))
    );
  });

  // Clients (wallet indexes 10..18)
  CLIENTS.forEach((client, i) => {
    users.push(
      clientData(client, pickWallet(CLIENT_WALLET_START + i))
    );
  });

  // Attach distinct phones for realism (optional field).
  users.forEach((u, i) => {
    u.phoneNumber = makePhone(i);
  });

  return users;
}

/**
 * Validate the whole plan before any DB write:
 *  - 19 users, correct role counts, no duplicate emails/usernames/wallets.
 */
function validatePlan(users) {
  if (users.length !== 19) {
    throw new Error(`Expected 19 users, got ${users.length}.`);
  }
  const admins = users.filter((u) => u.role === "admin").length;
  const sellers = users.filter((u) => u.role === "seller").length;
  const buyers = users.filter((u) => u.role === "buyer").length;
  if (admins !== 1 || sellers !== 9 || buyers !== 9) {
    throw new Error(`Role split must be 1 admin / 9 sellers / 9 clients — got ${admins}/${sellers}/${buyers}.`);
  }

  const seen = new Set();
  for (const u of users) {
    for (const field of ["email", "username", "walletAddress"]) {
      const value = u[field];
      if (!value) throw new Error(`${u.fullName}: missing ${field}`);
      if (seen.has(`${field}:${value}`)) {
        throw new Error(`Duplicate ${field} "${value}" across seeded users.`);
      }
      seen.add(`${field}:${value}`);
    }
  }

  // Emails must not collide with non-seeded users either (unique index).
  return true;
}

// =============================================================================
// MAIN
// =============================================================================
async function seedUsers() {
  const args = new Set(process.argv.slice(2));
  const fresh = args.has("--fresh");
  const dryRun = args.has("--dry-run");

  if (!MONGO_URI) {
    console.error("❌ MONGODB_URI not set in .env");
    process.exit(1);
  }

  const users = await buildUsers();
  validatePlan(users);

  // Print the login cheat-sheet regardless of write mode.
  console.log("──────────────────────────────────────────────");
  console.log("Seed plan (19 users)");
  console.log("──────────────────────────────────────────────");
  users.forEach((u) => {
    const role = u.role.padEnd(6);
    console.log(`  [${role}] ${u.email}  /  pwd: ${u.username}123`);
  });
  console.log("Wallets: admin=Account#0 · sellers=#1-#9 · clients=#10-#18 · spare=#19");
  console.log("Image placeholders: picsum.photos/seed/<key>-{avatar,cover,work-n} (see top of file)");
  console.log("──────────────────────────────────────────────");

  if (dryRun) {
    console.log("✅ Dry-run complete — validation passed, no writes performed.");
    return;
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const targetEmails = users.map((u) => u.email);

  if (fresh) {
    const deleted = await User.deleteMany({ email: { $in: targetEmails } });
    console.log(`🧹 --fresh: removed ${deleted.deletedCount} previous seeded user(s).`);
  }

  const summary = { created: 0, updated: 0, skipped: 0 };
  const experiences = [];

  try {
    for (const raw of users) {
      const payload = { ...raw, password: await bcrypt.hash(`${raw.username}123`, 10) };

      const existing = await User.findOne({
        $or: [{ email: payload.email }, { walletAddress: payload.walletAddress }],
      });

      if (existing) {
        await User.updateOne({ _id: existing._id }, { $set: payload });
        summary.updated += 1;
        console.log(`  → updated ${payload.email} (${payload.role})`);
      } else {
        await User.create(payload);
        summary.created += 1;
        console.log(`  → created ${payload.email} (${payload.role})`);
      }
    }
  } catch (error) {
    experiences.push(error);
  }

  console.log("──────────────────────────────────────────────");
  if (experiences.length > 0) {
    console.error("❌ Seeding partially failed:");
    experiences.forEach((e) => console.error("   ", e.message));
    console.error("   Check for a unique-key clash (email/username/walletAddress).");
    process.exitCode = 1;
  } else {
    console.log(`✅ Done — created: ${summary.created}, updated: ${summary.updated}, skipped: ${summary.skipped}`);
  }

  await mongoose.disconnect();
  console.log("Disconnected from MongoDB");
}

seedUsers().catch((error) => {
  console.error("❌ Seeding failed:", error);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});