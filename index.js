require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRETS);

const port = process.env.PORT || 5000;
const app = express();

// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// var serviceAccount = require("./clubsphere-firebase-adminsdk.json");

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

// Firebase Admin Initialization
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
//   "utf-8"
// );
// const serviceAccount = JSON.parse(decoded);

// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

// JWT Middleware for secure routes
// const verifyJWT = async (req, res, next) => {
//   const token = req?.headers?.authorization?.split(" ")[1];
//   if (!token) return res.status(401).send({ message: "Unauthorized Access!" });

//   try {
//     const decodedToken = await admin.auth().verifyIdToken(token);
//     req.userEmail = decodedToken.email;
//     console.log(decodedToken);
//     next();
//   } catch (err) {
//     return res.status(401).send({ message: "Unauthorized Access!", err });
//   }
// };

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.cdbx9rd.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  const db = client.db("ClubSphereDb");
  const clubCollection = db.collection("club");
  const eventCollection = db.collection("events");
  const userCollection = db.collection("users");
  const paymentCollection = db.collection("payments");
  const registrationCollection = db.collection("eventRegistrations");
  const membershipsCollection = db.collection("memberships");

  // Get user by email
  app.get("/users/:email", async (req, res) => {
    const email = req.params.email;

    const user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      name: user.name,
      email: user.email,
      role: user.role || "member",
      photoURL: user.photoURL,
      createdAt: user.createdAt,
    });
  });

  app.post("/users", async (req, res) => {
    const user = req.body;
    if (!user?.email)
      return res.status(400).json({ message: "Email required" });

    const existingUser = await userCollection.findOne({ email: user.email });
    if (existingUser) return res.status(409).json({ message: "User exists" });

    const result = await userCollection.insertOne({
      ...user,
      role: "member",
      createdAt: new Date(),
    });
    res
      .status(201)
      .json({ message: "User created", userId: result.insertedId });
  });

  // Get all clubs
  app.get("/club", async (req, res) => {
    const clubs = await clubCollection.find({ status: "approved" }).toArray();
    res.json(clubs);
  });

  // Get single club
  app.get("/club/:id", async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid club ID" });

    const club = await clubCollection.findOne({ _id: new ObjectId(id) });
    if (!club) return res.status(404).json({ message: "Club not found" });

    res.json(club);
  });

  // Featured clubs
  app.get("/featured-clubs", async (req, res) => {
    const featured = await clubCollection
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.json(featured);
  });

  // Get all events
  app.get("/events", async (req, res) => {
    const events = await eventCollection.find({}).toArray();
    res.json(events);
  });

  // Get single event
  app.get("/events/:id", async (req, res) => {
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid event ID" });

    const event = await eventCollection.findOne({ _id: new ObjectId(id) });
    if (!event) return res.status(404).json({ message: "Event not found" });

    res.json(event);
  });

  // Event registration
  app.post("/events/:id/register", async (req, res) => {
    const eventId = req.params.id;
    const { paymentId } = req.body;
    if (!ObjectId.isValid(eventId))
      return res.status(400).json({ message: "Invalid event ID" });

    const event = await eventCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) return res.status(404).json({ message: "Event not found" });

    const registration = await registrationCollection.insertOne({
      eventId: new ObjectId(eventId),
      clubId: event.clubId,
      userEmail: req.userEmail,
      status: "registered",
      paymentId: paymentId || null,
      registeredAt: new Date(),
    });

    res.status(201).json({ message: "Registered successfully", registration });
  });

  // Payments
  app.get("/payments", async (req, res) => {
    const email = req.query.email || req.userEmail;
    const query = email ? { userEmail: email } : {};
    const result = await paymentCollection.find(query).toArray();
    res.send(result);
  });

  // Stripe checkout session
  app.post("/create-checkout-session", async (req, res) => {
    const { clubId, clubName, membershipFee } = req.body;
    const amount = parseInt(membershipFee) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: { name: `${clubName} Membership Fee` },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: { clubId, clubName, userEmail: req.userEmail },
      customer_email: req.userEmail,
      success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled`,
    });

    res.send({ url: session.url });
  });

  // Stripe payment success
  app.patch("/payment-success", async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId)
      return res.status(400).send({ error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || !session.metadata)
      return res.status(400).send({ error: "Invalid session data" });
    if (session.payment_status !== "paid") return res.send({ success: false });

    const transactionId = session.payment_intent;
    const existing = await paymentCollection.findOne({ transactionId });
    if (existing)
      return res.send({
        success: true,
        message: "Payment already processed",
        transactionId,
      });

    const { clubId, clubName, userEmail } = session.metadata;

    const membershipData = {
      userEmail,
      clubId,
      status: "active",
      paymentId: transactionId,
      joinedAt: new Date(),
    };
    const membershipResult = await membershipsCollection.insertOne(
      membershipData
    );

    const paymentData = {
      userEmail,
      amount: session.amount_total,
      clubId,
      clubName,
      type: "membership",
      transactionId,
      status: session.payment_status,
      createdAt: new Date(),
    };
    const paymentResult = await paymentCollection.insertOne(paymentData);

    res.send({
      success: true,
      membership: membershipResult,
      payment: paymentResult,
      transactionId,
    });
  });
  // GET member overview stats
  app.get("/member-overview", async (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ message: "Email required" });

    const memberships = await membershipsCollection
      .find({ userEmail: email, status: "active" })
      .toArray();

    const registrations = await registrationCollection
      .find({ userEmail: email, status: "registered" })
      .toArray();

    const upcomingEvents = await Promise.all(
      registrations.map(async (reg) => {
        const event = await eventCollection.findOne({
          _id: new ObjectId(reg.eventId),
        });
        if (new Date(event.eventDate) >= new Date()) {
          const club = await clubCollection.findOne({
            _id: new ObjectId(event.clubId),
          });
          return {
            eventTitle: event.title,
            eventDate: event.eventDate,
            clubName: club.clubName,
          };
        }
      })
    );

    res.status(200).json({
      totalClubsJoined: memberships.length,
      totalEventsRegistered: registrations.length,
      upcomingEvents: upcomingEvents.filter(Boolean), // remove undefined
    });
  });

  await client.db("admin").command({ ping: 1 });
  console.log("Connected to MongoDB successfully!");
}

run().catch(console.dir);

app.get("/", (req, res) => res.send("My ClubSphere server is running..."));
app.listen(port, () => console.log(`Server running on port ${port}`));
