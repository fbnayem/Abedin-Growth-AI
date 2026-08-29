import { Lead, OutboxLogItem, ScoreBreakdown, Conversation, EmailMessage, ReplyIntent } from "../src/types";

interface ClinicTemplate {
  name: string;
  doctorName: string;
  doctorTitle: string;
  domain: string;
  city: string;
  country: string;
  industry: string;
  phonePrefix: string;
  employeeCount: string;
  specialty: string;
  painSignal: string;
}

const clinicTemplates: ClinicTemplate[] = [
  // Top tier London & flagship clinics
  {
    name: "Harley Street Aesthetic Clinic",
    doctorName: "Dr. Sarah Jenkins",
    doctorTitle: "Clinical Director & Partner",
    domain: "harleystreetaesthetics.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "15-30",
    specialty: "Facial Aesthetics & Anti-Aging",
    painSignal: "High-ticket £1,500+ consultation inquiries dropping on weekend phone queues",
  },
  {
    name: "Kensington Dental Care Group",
    doctorName: "Dr. Marcus Vance",
    doctorTitle: "Principal Dentist & Practice Owner",
    domain: "kensingtondentalcare.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "20-45",
    specialty: "General & Cosmetic Dentistry",
    painSignal: "Front-desk overloaded during morning patient rush; 24-hr callback delay on web leads",
  },
  {
    name: "Apex Dental & Implant Centers",
    doctorName: "Jonathan Thorne",
    doctorTitle: "Managing Partner & Commercial Director",
    domain: "apexdentalcenters.co.uk",
    city: "Manchester",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 161 496",
    employeeCount: "25-50",
    specialty: "Implantology & Full Arch Restoration",
    painSignal: "Losing high-value implant callers to competitors due to after-hours voicemail",
  },
  {
    name: "Marylebone Medical & Wellness Group",
    doctorName: "Elena Rostova",
    doctorTitle: "Head of Patient Operations",
    domain: "marylebonemedicalwellness.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "30-60",
    specialty: "Private GP & Preventative Health",
    painSignal: "Call center staffing cost exceeding £14K/mo with high evening abandonment",
  },
  {
    name: "Mayfair Specialty Health Group",
    doctorName: "Dr. Tariq Al-Mansoor",
    doctorTitle: "Medical Director",
    domain: "mayfairspecialtyhealth.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "20-40",
    specialty: "Private Diagnostics & Specialist Medicine",
    painSignal: "International patients calling in different time zones facing voicemail",
  },
  {
    name: "Edinburgh Orthodontics & Dental Studio",
    doctorName: "David Morrison",
    doctorTitle: "Principal Orthodontist",
    domain: "edinburghortho.co.uk",
    city: "Edinburgh",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 131 496",
    employeeCount: "15-25",
    specialty: "Invisalign & Specialist Orthodontics",
    painSignal: "Teen and adult Invisalign consultations require fast instant booking",
  },
  {
    name: "Bristol Health & Surgical Suites",
    doctorName: "Sophie Beaumont",
    doctorTitle: "Practice Director",
    domain: "bristolhealthsuites.co.uk",
    city: "Bristol",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 117 496",
    employeeCount: "20-35",
    specialty: "Day Surgery & Outpatient Care",
    painSignal: "Surgical pre-op questions clogging the front phone line during peak hours",
  },
  {
    name: "Regent Street Cosmetic & Dental Clinic",
    doctorName: "Dr. Priya Patel",
    doctorTitle: "Clinical Lead",
    domain: "regentstreetcosmetic.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "10-25",
    specialty: "Cosmetic Veneers & Smile Makeovers",
    painSignal: "High ad spend on social media generating evening calls that go unanswered",
  },
  {
    name: "Cambridge Dental Arts",
    doctorName: "Chloe Sinclair",
    doctorTitle: "Managing Director",
    domain: "cambridgedentalarts.co.uk",
    city: "Cambridge",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 1223 496",
    employeeCount: "12-25",
    specialty: "Restorative Dentistry & Periodontics",
    painSignal: "Weekend emergency toothache calls going to NHS 111 instead of private booking",
  },
  {
    name: "Manchester City Smiles Clinic",
    doctorName: "Oliver Wright",
    doctorTitle: "Operations Director",
    domain: "manchestercitysmiles.co.uk",
    city: "Manchester",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 161 496",
    employeeCount: "18-35",
    specialty: "Cosmetic Dentistry & Teeth Whitening",
    painSignal: "Young professional demographic calling after 6 PM wanting instant booking",
  },
  {
    name: "Chelsea Private Doctors Clinic",
    doctorName: "Dr. Alexander Sterling",
    doctorTitle: "Senior Partner",
    domain: "chelseaprivatedoctors.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 20 7946",
    employeeCount: "15-30",
    specialty: "Concierge Medicine & Home Visits",
    painSignal: "VIP patients demanding sub-5 second phone response day or night",
  },
  {
    name: "Oxford Dental Studio",
    doctorName: "Hannah Cooper",
    doctorTitle: "Practice Manager",
    domain: "oxforddentalstudio.co.uk",
    city: "Oxford",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 1865 496",
    employeeCount: "10-20",
    specialty: "Family & Aesthetic Dentistry",
    painSignal: "Busy reception desk unable to answer incoming calls while checking out patients",
  },
  {
    name: "Dubai Marina Dental Aesthetics Center",
    doctorName: "Dr. Zaid Al-Husseini",
    doctorTitle: "Chief Medical Officer",
    domain: "marinadentalaesthetics.ae",
    city: "Dubai",
    country: "UAE",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+971 4 399",
    employeeCount: "30-70",
    specialty: "Luxury Cosmetic Dentistry & Veneers",
    painSignal: "High inbound WhatsApp and phone call volume from international medical tourists",
  },
  {
    name: "Birmingham Specialist Dental Suite",
    doctorName: "Dr. Richard Hughes",
    doctorTitle: "Clinical Director",
    domain: "birminghamdentalsuite.co.uk",
    city: "Birmingham",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 121 496",
    employeeCount: "20-40",
    specialty: "Oral Surgery & Endodontics",
    painSignal: "Complex patient referrals requiring intake triage before scheduling",
  },
  {
    name: "Glasgow Aesthetic & Laser Clinic",
    doctorName: "Dr. Fiona Campbell",
    doctorTitle: "Medical Director",
    domain: "glasgowaesthetics.co.uk",
    city: "Glasgow",
    country: "United Kingdom",
    industry: "Aesthetic & Cosmetic Surgery",
    phonePrefix: "+44 141 496",
    employeeCount: "15-30",
    specialty: "Laser Dermatology & Injectables",
    painSignal: "Patients asking repetitive pricing and downtime questions on phone calls",
  },
  {
    name: "Leeds Central Orthodontic Practice",
    doctorName: "Dr. Alistair Macleod",
    doctorTitle: "Principal Orthodontist",
    domain: "leedsorthocentral.co.uk",
    city: "Leeds",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 113 496",
    employeeCount: "15-28",
    specialty: "Clear Aligners & Pediatric Ortho",
    painSignal: "Parents calling after school hours to book consultations",
  },
  {
    name: "Bath Cosmetic Dentistry & Facial Clinic",
    doctorName: "Dr. Charlotte Davies",
    doctorTitle: "Practice Owner",
    domain: "bathcosmeticdentistry.co.uk",
    city: "Bath",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 1225 496",
    employeeCount: "12-22",
    specialty: "Smile Design & Facial Rejuvenation",
    painSignal: "Reception overwhelmed on Mondays managing weekend voicemails",
  },
  {
    name: "Knightsbridge Plastic Surgery Center",
    doctorName: "Dr. Julian Ross",
    doctorTitle: "Consultant Plastic Surgeon",
    domain: "knightsbridgeplasticsurgery.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Aesthetic & Cosmetic Surgery",
    phonePrefix: "+44 20 7946",
    employeeCount: "25-50",
    specialty: "Cosmetic & Reconstructive Surgery",
    painSignal: "£8,000+ surgery inquiries requiring strict qualification and rapid consultation booking",
  },
  {
    name: "London Veterinary Emergency Specialists",
    doctorName: "Dr. Samantha Cole",
    doctorTitle: "Head of Emergency Operations",
    domain: "londonvetspecialists.co.uk",
    city: "London",
    country: "United Kingdom",
    industry: "Veterinary & Specialist Care",
    phonePrefix: "+44 20 7946",
    employeeCount: "35-70",
    specialty: "24/7 Veterinary Emergency Care",
    painSignal: "Distressed pet owners calling at 2 AM needing instant triage and arrival registration",
  },
  {
    name: "Cardiff Smile & Implant Studio",
    doctorName: "Dr. Gethin Morgan",
    doctorTitle: "Principal Dentist",
    domain: "cardiffsmilestudio.co.uk",
    city: "Cardiff",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 29 2049",
    employeeCount: "14-25",
    specialty: "Digital Dentistry & Dental Implants",
    painSignal: "Marketing campaigns generating 40+ weekly phone inquiries during closed hours",
  },
  {
    name: "Newcastle Cosmetic Skin & Laser Center",
    doctorName: "Dr. Eleanor Armstrong",
    doctorTitle: "Dermatology Director",
    domain: "newcastleskincenter.co.uk",
    city: "Newcastle",
    country: "United Kingdom",
    industry: "Aesthetic & Cosmetic Surgery",
    phonePrefix: "+44 191 496",
    employeeCount: "16-30",
    specialty: "Medical Dermatology & Laser Treatments",
    painSignal: "High telephone abandonment rate on Friday afternoons and Saturday mornings",
  },
  {
    name: "Belfast Private Healthcare & Dental",
    doctorName: "Dr. Patrick Moore",
    doctorTitle: "Managing Partner",
    domain: "belfastprivatehealth.co.uk",
    city: "Belfast",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 28 9049",
    employeeCount: "20-40",
    specialty: "Multi-Specialty Private Care",
    painSignal: "Patients waiting on hold for over 4 minutes during peak lunch hour",
  },
  {
    name: "Brighton Seafront Dental & Implant Clinic",
    doctorName: "Dr. Lauren Brooks",
    doctorTitle: "Practice Principal",
    domain: "brightonseafrontdental.co.uk",
    city: "Brighton",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 1273 496",
    employeeCount: "12-24",
    specialty: "Restorative & Emergency Dentistry",
    painSignal: "Weekend tourist dental emergencies lost to local hospital A&E",
  },
  {
    name: "Nottingham Orthodontics & Dental Spa",
    doctorName: "Dr. Benjamin Hayes",
    doctorTitle: "Clinical Director",
    domain: "nottinghamorthospa.co.uk",
    city: "Nottingham",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 115 496",
    employeeCount: "14-28",
    specialty: "Adult Orthodontics & Sedation Dentistry",
    painSignal: "Nervous patients hanging up on voicemail without booking initial consultation",
  },
  {
    name: "Sheffield Advanced Dental Care",
    doctorName: "Dr. Victoria Sterling",
    doctorTitle: "Practice Director",
    domain: "sheffieldadvanceddental.co.uk",
    city: "Sheffield",
    country: "United Kingdom",
    industry: "Dental & Healthcare Clinics",
    phonePrefix: "+44 114 496",
    employeeCount: "18-32",
    specialty: "Advanced Periodontics & Implants",
    painSignal: "Referral patient phone coordination taking 30% of head nurse's clinical time",
  },
];

const firstNames = [
  "Sarah", "Marcus", "Eleanor", "Richard", "Fiona", "James", "Alistair", "Charlotte", "Tariq", "David",
  "Sophie", "Oliver", "Alexander", "Hannah", "Zaid", "Julian", "Samantha", "Gethin", "Eleanor", "Patrick",
  "Lauren", "Benjamin", "Victoria", "Edward", "Liam", "Amira", "Zara", "Lucas", "Maya", "Daniel",
  "Clara", "Adam", "Rachel", "Sebastian", "Emily", "Nathan", "Jessica", "Thomas", "Rebecca", "George",
  "Isabella", "Christopher", "Sophia", "Matthew", "Grace", "William", "Olivia", "Joseph", "Mia", "Arthur",
  "Ella", "Harry", "Ava", "Henry", "Freya", "Leo", "Lily", "Freddie", "Chloe", "Oscar",
  "Poppy", "Jack", "Ivy", "Charlie", "Florence", "Theo", "Daisy", "Alfie", "Evie", "Archie"
];

const lastNames = [
  "Jenkins", "Vance", "Thorne", "Rostova", "Al-Mansoor", "Morrison", "Beaumont", "Patel", "Sinclair", "Wright",
  "Sterling", "Cooper", "Al-Husseini", "Hughes", "Campbell", "Macleod", "Davies", "Ross", "Cole", "Morgan",
  "Armstrong", "Moore", "Brooks", "Hayes", "Hawthorne", "Mercer", "Chen", "Sinclair", "Wood", "Bennett",
  "Clarke", "Taylor", "Wilson", "Evans", "Walker", "Robinson", "Thompson", "White", "Watson", "Jackson",
  "Harris", "Martin", "Brown", "Williams", "Jones", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez",
  "Lopez", "Gonzalez", "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez", "Diaz",
  "Reyes", "Morales", "Cruz", "Ortiz", "Gutierrez", "Chavez", "Ramos", "Castillo", "Vargas", "Mendoza"
];

const cities = [
  { city: "London", prefix: "+44 20 7946", country: "United Kingdom" },
  { city: "Manchester", prefix: "+44 161 496", country: "United Kingdom" },
  { city: "Birmingham", prefix: "+44 121 496", country: "United Kingdom" },
  { city: "Edinburgh", prefix: "+44 131 496", country: "United Kingdom" },
  { city: "Glasgow", prefix: "+44 141 496", country: "United Kingdom" },
  { city: "Bristol", prefix: "+44 117 496", country: "United Kingdom" },
  { city: "Leeds", prefix: "+44 113 496", country: "United Kingdom" },
  { city: "Liverpool", prefix: "+44 151 496", country: "United Kingdom" },
  { city: "Newcastle", prefix: "+44 191 496", country: "United Kingdom" },
  { city: "Sheffield", prefix: "+44 114 496", country: "United Kingdom" },
  { city: "Oxford", prefix: "+44 1865 496", country: "United Kingdom" },
  { city: "Cambridge", prefix: "+44 1223 496", country: "United Kingdom" },
  { city: "Cardiff", prefix: "+44 29 2049", country: "United Kingdom" },
  { city: "Belfast", prefix: "+44 28 9049", country: "United Kingdom" },
  { city: "Nottingham", prefix: "+44 115 496", country: "United Kingdom" },
  { city: "Bath", prefix: "+44 1225 496", country: "United Kingdom" },
  { city: "Brighton", prefix: "+44 1273 496", country: "United Kingdom" },
  { city: "Southampton", prefix: "+44 23 8049", country: "United Kingdom" },
  { city: "Leicester", prefix: "+44 116 496", country: "United Kingdom" },
  { city: "York", prefix: "+44 1904 496", country: "United Kingdom" },
  { city: "Dubai", prefix: "+971 4 399", country: "UAE" },
  { city: "Dublin", prefix: "+353 1 496", country: "Ireland" },
  { city: "New York", prefix: "+1 212 555", country: "United States" },
  { city: "Los Angeles", prefix: "+1 310 555", country: "United States" },
];

const clinicTypes = [
  "Dental Care Group",
  "Aesthetic & Skin Clinic",
  "Implant & Orthodontic Center",
  "Specialist Dental Practice",
  "Cosmetic Smile Studio",
  "Private Medical & Diagnostics",
  "Facial Aesthetics & Surgery",
  "Veterinary Hospital & Surgery",
  "Dermatology & Laser Clinic",
  "Day Surgery & Wellness Suites",
  "Orthopedic & Sports Therapy",
  "Family Dental & Hygiene Center",
];

const titles = [
  "Clinical Director",
  "Principal Dentist & Practice Owner",
  "Managing Director",
  "Head of Practice Operations",
  "Medical Director",
  "Lead Cosmetic Surgeon",
  "Senior Practice Partner",
  "Commercial Director",
  "Chief Medical Officer",
  "Practice Manager & Partner",
];

// Rich clinical conversation templates with realistic prospect questions & agent answers
const replyScenarios: {
  intent: ReplyIntent;
  clientReply: (lead: Lead) => string;
  agentFollowup: (lead: Lead) => string;
  summary: string;
  recommendedAction: string;
  nextStep: string;
}[] = [
  {
    intent: "INTERESTED",
    clientReply: (l) =>
      `Hi Nayem,\n\nThanks for reaching out. We indeed lose a noticeable number of inquiries on Friday evenings and Sunday afternoons when patients are researching private treatments.\n\nHow does your system handle live calendar scheduling? Does it sync directly with Google Calendar so our clinic coordinators don't have to re-enter appointment slots manually?\n\nBest,\n${l.name}\n${l.title} | ${l.companyName}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nThanks for your reply! Yes—Abedin Voice AI features native 2-way real-time integration with Google Calendar, Outlook, and webhook bridges for practice software.\n\nWhen a caller books a consultation, the agent checks live availability, confirms the slot, and adds details directly into your calendar with zero manual entry.\n\nCould we do a quick 10-minute live demonstration on Google Meet this Thursday afternoon so you can experience the latency and calendar sync firsthand?\n\nDirect link: https://meet.google.com/abn-vce-demo\n\nBest regards,\nNayem Abedin\nFounder, Abedin Tech`,
    summary: "Expressed strong interest regarding weekend call overflow. Inquired if Abedin Voice AI syncs directly with Google Calendar.",
    recommendedAction: "Confirm 2-way real-time calendar syncing and provide Google Meet demo link.",
    nextStep: "Trigger live demo walkthrough & lock in meeting",
  },
  {
    intent: "DEMO_REQUESTED",
    clientReply: (l) =>
      `Nayem,\n\nWe spend over £4k/month on Google Ads for private treatments and missed evening calls are indeed a real pain point for our ${l.companyName} branches. Can we do a 15-minute screen demo this Thursday at 2:00 PM?\n\nRegards,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nConfirmed! I have sent across a Google Meet calendar invitation for Thursday at 2:00 PM BST.\n\nI'll walk you through our live latency benchmark, practice calendar sync, and how the voice AI answers clinic inquiries in under 500ms.\n\nLooking forward to speaking.\n\nBest,\nNayem Abedin\nFounder & CEO, Abedin Tech`,
    summary: "Commercial Director requested a 15-minute live screen demo for Thursday at 2:00 PM to verify integration with advertising campaigns.",
    recommendedAction: "Confirm Thursday 2:00 PM demo and send Google Meet link.",
    nextStep: "Prepare customized practice battlecard and Google Meet invite",
  },
  {
    intent: "PRICING_QUESTION",
    clientReply: (l) =>
      `Hello Nayem,\n\nWhat are your subscription packages for a clinic setup handling roughly 2,000-3,000 minutes of inbound calls across our practice suites? Do you charge per phone line or per call minute?\n\nThanks,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nOur Growth Tier (£499/mo) covers all practice numbers, includes 2,500 voice minutes, and enables multi-calendar booking. Additional minutes are just 8p/min with no surge rates.\n\nWe also offer an onboarding trial with zero upfront setup fees. Would you like to review the breakdown over a quick 10-minute Google Meet walkthrough this week?\n\nDirect link: https://meet.google.com/abn-vce-demo\n\nBest,\nNayem Abedin\nFounder & CEO, Abedin Tech`,
    summary: "Requested specific pricing packages for multi-location practice handling 2,000-3,000 monthly voice minutes.",
    recommendedAction: "Review Growth Tier (£499/mo) quote and offer 10-minute discovery walkthrough.",
    nextStep: "Send pricing proposal & calculate practice ROI audit",
  },
  {
    intent: "TECHNICAL",
    clientReply: (l) =>
      `Hi Nayem,\n\nWe have been discussing after-hours emergency call answering for our surgery suites. Could you share an audio demo or explain how the bot triages acute pain emergencies vs routine checkup inquiries?\n\nRegards,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nFor dental/medical emergencies (e.g. severe pain or trauma), the agent is instructed under deterministic clinical guardrails to identify pain severity, capture private status, and immediately reserve your designated emergency morning slot while dispatching an instant SMS confirmation.\n\nWould you like to review the live interactive demo on Google Meet this week?\n\nDirect link: https://meet.google.com/abn-vce-demo\n\nBest,\nNayem Abedin\nFounder & CEO, Abedin Tech`,
    summary: "Confirmed after-hours emergency call drop-off. Requested explanation of acute triage guardrails vs routine bookings.",
    recommendedAction: "Provide concise explanation of emergency triage flow and offer phone call simulation.",
    nextStep: "Send audio proof link & trigger live desk phone demo",
  },
  {
    intent: "QUESTION",
    clientReply: (l) =>
      `Good afternoon Nayem.\n\nOur practice receives high telephone inquiry volume for cosmetic consultations. If a patient asks specific questions about financing options or procedure downtime, does the voice AI give accurate custom answers according to our clinic protocol?\n\nBest,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nYes! We upload your clinic knowledge base (pricing, downtime, 0% financing terms, and doctor bios) so the AI provides precise, approved answers to prospective patients within 500ms.\n\nIf a complex question exceeds its knowledge, it gracefully warm-transfers to your staff or offers an instant callback.\n\nWould you like to test a mock scenario?\n\nBest,\nNayem`,
    summary: "Inquired about knowledge base ingestion for financing options and procedure recovery times.",
    recommendedAction: "Explain knowledge base ingestion and offer mock scenario test.",
    nextStep: "Generate customized practice knowledge preview",
  },
  {
    intent: "INTERESTED",
    clientReply: (l) =>
      `Hi Nayem,\n\nThis is timely—our reception team has been struggling with high phone hold times during morning peak hours (8:30-10:30 AM). Can the AI run concurrently with our human front desk as an overflow buffer?\n\nKind regards,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nPrecisely! Many practices use Abedin Voice AI as an intelligent overflow ring group. If your reception desk doesn't pick up within 3 rings, the AI seamlessly answers so zero patients abandon.\n\nCan we set up a 10-minute trial for ${l.companyName} this Friday?\n\nBest,\nNayem Abedin`,
    summary: "Reported heavy morning phone queues and requested overflow buffer implementation.",
    recommendedAction: "Confirm intelligent SIP overflow ring group setup and propose 10-minute trial.",
    nextStep: "Schedule SIP overflow trial setup",
  },
  {
    intent: "MEETING_REQUEST",
    clientReply: (l) =>
      `Nayem,\n\nI reviewed your note with our practice partners. We'd like to see a live demonstration of how it handles patient bookings into our calendar. Are you free Friday at 11:00 AM for a 20-minute Zoom?\n\nBest,\n${l.name}`,
    agentFollowup: (l) =>
      `Hi ${l.name.replace("Dr. ", "").split(" ")[0]},\n\nFriday at 11:00 AM works perfectly. I have dispatched a calendar invite with the Google Meet conference details.\n\nLooking forward to meeting you and the partners.\n\nBest,\nNayem Abedin`,
    summary: "Partner requested a 20-minute live demonstration for Friday at 11:00 AM.",
    recommendedAction: "Send Google Meet calendar invite for Friday 11:00 AM.",
    nextStep: "Prepare live partner screen share demo",
  },
];

/**
 * Generates 400 realistic leads discovered and contacted across 4 days (100 per day),
 * with complete outbox records and authentic conversation threads for all engaged/demo leads.
 */
export function generateFourHundredHistoricalLeads(): {
  leads: Lead[];
  outboxLogs: OutboxLogItem[];
  conversations: Conversation[];
} {
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;

  const day4Start = now - dayMs * 4;
  const day3Start = now - dayMs * 3;
  const day2Start = now - dayMs * 2;
  const day1Start = now - dayMs * 1;

  const leads: Lead[] = [];
  const outboxLogs: OutboxLogItem[] = [];
  const conversations: Conversation[] = [];

  for (let i = 0; i < 400; i++) {
    // Determine which day this lead belongs to (0-99 = Day 4, 100-199 = Day 3, 200-299 = Day 2, 300-399 = Day 1)
    let dayIndex = 4; // 4 days ago
    let baseTime = day4Start;
    if (i >= 100 && i < 200) {
      dayIndex = 3;
      baseTime = day3Start;
    } else if (i >= 200 && i < 300) {
      dayIndex = 2;
      baseTime = day2Start;
    } else if (i >= 300) {
      dayIndex = 1;
      baseTime = day1Start;
    }

    // Offset in seconds across that day (spaced out by a few minutes)
    const minuteOffset = (i % 100) * 12 + Math.floor(Math.random() * 8);
    const discoveredTimestamp = new Date(baseTime + minuteOffset * 60 * 1000).toISOString();
    // Contacted 4 to 18 minutes after discovery
    const contactedTimestamp = new Date(baseTime + (minuteOffset + 7) * 60 * 1000).toISOString();

    let leadName = "";
    let leadTitle = "";
    let companyName = "";
    let companyDomain = "";
    let city = "";
    let country = "United Kingdom";
    let phonePrefix = "+44 20 7946";
    let industry = "Dental & Healthcare Clinics";
    let employeeCount = "15-30";
    let painSignal = "Front-desk phone queues and after-hours consultation booking drop-off";

    if (i < clinicTemplates.length) {
      const tmpl = clinicTemplates[i];
      leadName = tmpl.doctorName;
      leadTitle = tmpl.doctorTitle;
      companyName = tmpl.name;
      companyDomain = tmpl.domain;
      city = tmpl.city;
      country = tmpl.country;
      phonePrefix = tmpl.phonePrefix;
      industry = tmpl.industry;
      employeeCount = tmpl.employeeCount;
      painSignal = tmpl.painSignal;
    } else {
      const fn = firstNames[i % firstNames.length];
      const ln = lastNames[(i * 3 + 7) % lastNames.length];
      leadName = (i % 3 === 0 ? "Dr. " : "") + `${fn} ${ln}`;
      leadTitle = titles[i % titles.length];

      const loc = cities[i % cities.length];
      city = loc.city;
      country = loc.country;
      phonePrefix = loc.prefix;

      const cType = clinicTypes[i % clinicTypes.length];
      const descriptor = (i % 4 === 0 ? "Premier " : i % 3 === 0 ? "Central " : "") + `${city} ${cType}`;
      companyName = descriptor;
      const cleanSlug = companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
      companyDomain = `${cleanSlug}.co.uk`;

      if (cType.includes("Aesthetic") || cType.includes("Skin") || cType.includes("Laser")) {
        industry = "Aesthetic & Cosmetic Surgery";
      } else if (cType.includes("Veterinary")) {
        industry = "Veterinary & Specialist Care";
      } else if (cType.includes("Medical") || cType.includes("Diagnostics")) {
        industry = "Private Medical & Diagnostics";
      } else {
        industry = "Dental & Healthcare Clinics";
      }
      employeeCount = `${12 + (i % 20)}-${30 + (i % 40)}`;
      painSignal = `Losing approximately £${(5 + (i % 12)) * 1000}/month in uncaptured telephone bookings during peak and after-hours times.`;
    }

    const cleanEmailName = leadName.toLowerCase().replace("dr. ", "").replace(/[^a-z]/g, ".");
    const email = `${cleanEmailName}@${companyDomain}`;
    const phoneNum = `${phonePrefix} 0${String(100 + ((i * 13) % 899))}`;

    // Score between 84 and 98
    const aiScore = 84 + ((i * 7) % 15);

    // Status distribution:
    // 20 DEMO_SCHEDULED
    // 70 ENGAGED (replied)
    // 8 WON
    // 302 CONTACTED (initial outreach sent)
    // Total customer conversations with replies: 98 (plus 7 investor/partner = 105 in inbox)
    let status: Lead["status"] = "CONTACTED";
    if (i < 20) {
      status = "DEMO_SCHEDULED";
    } else if (i < 28) {
      status = "WON";
    } else if (i < 98) {
      status = "ENGAGED";
    }

    const channel: "EMAIL" | "LINKEDIN" = i % 11 === 0 ? "LINKEDIN" : "EMAIL";

    const scoreBreakdown: ScoreBreakdown = {
      icpFit: Math.min(30, 24 + (i % 6)),
      painProbability: Math.min(25, 20 + (i % 5)),
      intent: Math.min(20, 15 + (i % 5)),
      decisionMakerQuality: Math.min(15, 12 + (i % 4)),
      contactability: Math.min(10, 8 + (i % 3)),
      totalScore: aiScore,
      reasons: [
        `High-ticket private consultation inquiries with 35%+ arriving outside standard reception hours`,
        `${leadTitle} has direct signing authority for practice phone and booking technology`,
        `Operating in high-demand ${city} market with heavy telephone patient scheduling volume`,
      ],
      buyingSignals: [
        `Clinic website promotes same-day appointments but routes evening callers to voicemail`,
        `Actively advertising private treatments on Google Ads / social media`,
      ],
      potentialRisks: i % 7 === 0 ? ["Requires clinical practice management software integration verification"] : [],
    };

    const firstNameOnly = leadName.replace("Dr. ", "").split(" ")[0];
    const subject = `Quick question regarding ${companyName}'s after-hours patient calls`;
    const body = `Hi ${firstNameOnly},\n\nNoticed ${companyName}'s patient volume in ${city}.\n\nWe built Abedin Voice AI so premier dental and healthcare practices never drop high-ticket patient consultations after 5 PM or during busy lunch hours. It operates with sub-500ms voice response latency, qualifies inquiries, and books directly into your practice calendar.\n\nWould you be open to a quick 10-minute live demonstration on Google Meet this week to see how it operates in real time?\n\nDirect walkthrough link: https://meet.google.com/abn-vce-demo\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech\nhttps://abedintech.com/voice-ai/`;

    const leadId = `lead_uk_${i + 1}`;
    const conversationId = `conv_lead_${leadId}`;

    const lead: Lead = {
      id: leadId,
      workspaceId: "default",
      type: "CUSTOMER",
      name: leadName,
      title: leadTitle,
      email: email,
      phone: phoneNum,
      linkedinUrl: `https://www.linkedin.com/in/${cleanEmailName.replace(/\./g, "")}`,
      companyName: companyName,
      companyWebsite: `https://${companyDomain}`,
      industry: industry,
      country: country,
      employeeCount: employeeCount,
      status: status,
      aiScore: aiScore,
      scoreBreakdown: scoreBreakdown,
      inboundCallVolumeLikelihood: "HIGH",
      recommendedPitch: `Autonomous 24/7 Voice AI receptionist answering patient booking calls in under 500ms and syncing with ${companyName}'s calendar.`,
      bestOutreachAngle: `Recovering missed high-value appointments during busy clinic hours and weekends (${painSignal}).`,
      personalizationSnippets: [
        {
          text: `Given ${companyName}'s reputation in ${city}, automating after-hours phone triage captures high-intent patient callers with zero wait time.`,
          sourceType: "Practice Structure Analysis",
          confidence: 0.95,
        },
      ],
      discoveredAt: discoveredTimestamp,
      createdAt: discoveredTimestamp,
      contactedAt: contactedTimestamp,
      lastActivityAt: contactedTimestamp,
      lastOutreachSubject: subject,
      lastOutreachBody: body,
      lastOutreachChannel: channel,
      emailStatus:
        status === "ENGAGED" || status === "DEMO_SCHEDULED" || status === "WON"
          ? "REPLIED"
          : i % 5 === 0
          ? "CLICKED"
          : i % 3 === 0
          ? "OPENED"
          : "DELIVERED",
      openCount:
        status === "ENGAGED" || status === "DEMO_SCHEDULED" || status === "WON"
          ? 3 + (i % 3)
          : i % 3 === 0
          ? 1 + (i % 2)
          : 0,
      lastOpenedAt:
        status === "ENGAGED" || status === "DEMO_SCHEDULED" || status === "WON" || i % 3 === 0
          ? new Date(new Date(contactedTimestamp).getTime() + (45 + (i % 60)) * 60 * 1000).toISOString()
          : undefined,
      clickedAt:
        status === "DEMO_SCHEDULED" || status === "WON" || i % 5 === 0
          ? new Date(new Date(contactedTimestamp).getTime() + (90 + (i % 60)) * 60 * 1000).toISOString()
          : undefined,
      spamScore: 0.0,
      recommendedActionLabel:
        status === "ENGAGED"
          ? "⚡ Lock in Demo Walkthrough"
          : status === "DEMO_SCHEDULED"
          ? "📋 View Pre-Meeting Brief"
          : status === "WON"
          ? "🏆 View Active Account"
          : status === "CONTACTED"
          ? "📨 Send Latency Follow-up"
          : "🚀 Dispatch Cold Pitch",
      recommendedActionReason:
        status === "ENGAGED"
          ? "Prospect replied with interest. Propose 2 demo time slots or calendar link."
          : status === "DEMO_SCHEDULED"
          ? "Demo locked in calendar. Review clinic diagnostic points."
          : status === "WON"
          ? "Contract signed and voice agent active."
          : status === "CONTACTED"
          ? "Email delivered and opened. Send follow-up addressing after-hours calls."
          : "High ICP score. Send personalized cold email pitch.",
      actionUrgency:
        status === "ENGAGED" || status === "DEMO_SCHEDULED"
          ? "HIGH"
          : status === "CONTACTED"
          ? "MEDIUM"
          : "LOW",
      nextAction:
        status === "ENGAGED"
          ? "Follow up with custom calendar demo"
          : status === "DEMO_SCHEDULED"
          ? "Prepare pre-demo practice audit & Google Meet"
          : status === "WON"
          ? "Active Autonomous Voice Receptionist Deployed"
          : "Monitor for reply",
      assignedCampaignId: "camp_dental_1",
      notes: `Discovered on Day ${5 - dayIndex} of 4-day engine run. Contacted via ${channel} with verified delivery.`,
    };

    leads.push(lead);

    // Create Outbox Log for initial sent touch
    const outboxStatus: OutboxLogItem["status"] =
      status === "ENGAGED" || status === "DEMO_SCHEDULED" || status === "WON"
        ? "REPLIED"
        : i % 3 === 0
        ? "OPENED"
        : "DELIVERED";

    outboxLogs.push({
      id: `outbox_log_${i + 1}`,
      recipientName: leadName,
      recipientEmail: email,
      recipientTitle: leadTitle,
      companyName: companyName,
      channel: channel,
      senderEmail: "nayem@abedintech.com",
      senderName: "Nayem Abedin",
      subject: subject,
      bodyText: body,
      sentAt: contactedTimestamp,
      status: outboxStatus,
      qcScore: 97 + (i % 3),
      openCount: lead.openCount,
      lastOpenedAt: lead.lastOpenedAt,
      clickedAt: lead.clickedAt,
      spamScore: 0.0,
      deliverabilityStatus: "VERIFIED_CLEAN",
      campaignName: "UK Dental & Healthcare Inbound Voice Receptionist",
      category: "CUSTOMER",
      leadId: lead.id,
    });

    // If this lead is ENGAGED (replied), DEMO_SCHEDULED, or WON, generate the full back-and-forth conversation thread!
    if (status === "ENGAGED" || status === "DEMO_SCHEDULED" || status === "WON") {
      const scenario = replyScenarios[i % replyScenarios.length];
      const replyTime = new Date(new Date(contactedTimestamp).getTime() + (3 * 3600 + (i % 8) * 1800) * 1000).toISOString();
      const followupTime = new Date(new Date(replyTime).getTime() + (25 + (i % 20)) * 60 * 1000).toISOString();

      const thread: EmailMessage[] = [
        // 1. Initial Outbound Message Sent by Agent
        {
          id: `msg_init_${i + 1}`,
          conversationId,
          sender: "AGENT",
          senderName: "Nayem Abedin",
          senderEmail: "nayem@abedintech.com",
          recipientEmail: email,
          subject: subject,
          bodyHtml: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          bodyText: body,
          sentAt: contactedTimestamp,
          status: "SENT",
          qcScore: 98,
          qcDecision: "PASS",
        },
        // 2. Inbound Client Reply Received from Prospect
        {
          id: `msg_reply_${i + 1}`,
          conversationId,
          sender: "PROSPECT",
          senderName: leadName,
          senderEmail: email,
          recipientEmail: "nayem@abedintech.com",
          subject: `Re: ${subject}`,
          bodyHtml: `<p>${scenario.clientReply(lead).replace(/\n/g, "<br/>")}</p>`,
          bodyText: scenario.clientReply(lead),
          sentAt: replyTime,
          status: "SENT",
        },
        // 3. Agent Follow-up Sent Back to Client
        {
          id: `msg_followup_${i + 1}`,
          conversationId,
          sender: "AGENT",
          senderName: "Nayem Abedin",
          senderEmail: "nayem@abedintech.com",
          recipientEmail: email,
          subject: `Re: ${subject}`,
          bodyHtml: `<p>${scenario.agentFollowup(lead).replace(/\n/g, "<br/>")}</p>`,
          bodyText: scenario.agentFollowup(lead),
          sentAt: followupTime,
          status: "SENT",
          qcScore: 99,
          qcDecision: "PASS",
        },
      ];

      // If WON or DEMO_SCHEDULED, add a 4th confirmation / booking message
      if (status === "DEMO_SCHEDULED" || status === "WON") {
        const confirmTime = new Date(new Date(followupTime).getTime() + 45 * 60 * 1000).toISOString();
        thread.push({
          id: `msg_confirm_${i + 1}`,
          conversationId,
          sender: "PROSPECT",
          senderName: leadName,
          senderEmail: email,
          recipientEmail: "nayem@abedintech.com",
          subject: `Re: ${subject}`,
          bodyHtml: `<p>Hi Nayem,<br/><br/>Confirmed on our end. The Google Meet link has been added to our practice calendar. Looking forward to testing the voice reception system.<br/><br/>Best,<br/>${firstNameOnly}</p>`,
          bodyText: `Hi Nayem,\n\nConfirmed on our end. The Google Meet link has been added to our practice calendar. Looking forward to testing the voice reception system.\n\nBest,\n${firstNameOnly}`,
          sentAt: confirmTime,
          status: "SENT",
        });
      }

      const convStatus =
        status === "DEMO_SCHEDULED"
          ? "MEETING_REQUESTED"
          : status === "WON"
          ? "CLOSED"
          : i % 4 === 0
          ? "HUMAN_NEEDED"
          : "ACTIVE";

      conversations.push({
        id: conversationId,
        workspaceId: "default",
        leadId: lead.id,
        subject: `Re: ${subject}`,
        contactName: leadName,
        contactEmail: email,
        contactTitle: leadTitle,
        companyName: companyName,
        category: "CUSTOMER",
        status: convStatus,
        lastReplyIntent: scenario.intent,
        intentConfidence: 0.96,
        aiSummary: `${leadName} (${leadTitle}): ${scenario.summary}`,
        aiRecommendedAction: scenario.recommendedAction,
        proposedAiDraft: {
          subject: `Re: ${subject}`,
          body: scenario.agentFollowup(lead),
          rationale: "Addresses technical integration directly and drives towards phone demo commitment.",
          policyStatus: { actionName: "SEND_REPLY", decision: "ALLOW", reason: "Within autonomous scope" },
        },
        thread,
        unread: true,
        updatedAt: followupTime,
      });

      // Update lead's lastActivityAt to most recent message
      lead.lastActivityAt = followupTime;
    }
  }

  return { leads, outboxLogs, conversations };
}
