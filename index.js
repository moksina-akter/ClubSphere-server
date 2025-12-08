require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 5000;

// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
//   "utf-8"
// );
// const serviceAccount = JSON.parse(decoded);
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });

const app = express();
// middleware
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
// const verifyJWT = async (req, res, next) => {
//   const token = req?.headers?.authorization?.split(" ")[1];
//   console.log(token);
//   if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
//   try {
//     const decoded = await admin.auth().verifyIdToken(token);
//     req.tokenEmail = decoded.email;
//     console.log(decoded);
//     next();
//   } catch (err) {
//     console.log(err);
//     return res.status(401).send({ message: "Unauthorized Access!", err });
//   }
// };

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.cdbx9rd.mongodb.net/?appName=Cluster0`;
const stripe = require("stripe")(process.env.STRIPE_SECRETS);
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("ClubSphereDb");
    const clubCollection = db.collection("club");
    const eventCollection = db.collection("events");
    const userCollection = db.collection("users");
    const paymentCollection = db.collection("payments");
    const registrationCollection = db.collection("eventRegistrations");
    const membershipsCollection = db.collection("memberships");

    //users collection
    app.post("/users", async (req, res) => {
      const user = req.body;

      if (!user?.email) {
        return res.status(400).json({ message: "Email is required" });
      }

      // check if user already exists
      const existingUser = await userCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.status(409).json({ message: "User already exists" });
      }

      const result = await userCollection.insertOne(user);
      res.status(201).json({
        message: "User created successfully",
        userId: result.insertedId,
      });
    });
    // GET all clubs
    app.get("/club", async (req, res) => {
      const clubs = await clubCollection.find({ status: "approved" }).toArray();
      res.json(clubs);
    });
    // GET single club by ID
    app.get("/club/:id", async (req, res) => {
      const id = req.params.id;
      const club = await clubCollection.findOne({ _id: new ObjectId(id) });
      if (!club) return res.status(404).json({ message: "Club not found" });
      res.json(club);
    });

    //get 6 featuredclub
    app.get("/featured-clubs", async (req, res) => {
      const featured = await clubCollection
        .find({ status: "approved" })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();

      res.json(featured);
    });

    // GET all events
    app.get("/events", async (req, res) => {
      const events = await eventCollection.find({}).toArray();
      res.json(events);
    });

    // GET single event by ID
    app.get("/events/:id", async (req, res) => {
      const id = req.params.id;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid event ID" });
      }

      const event = await eventCollection.findOne({ _id: new ObjectId(id) });
      if (!event) return res.status(404).json({ message: "Event not found" });

      res.json(event);
    });
    // POST register for an event
    app.post("/events/:id/register", async (req, res) => {
      const eventId = req.params.id;
      const { userEmail, paymentId } = req.body;

      if (!ObjectId.isValid(eventId)) {
        return res.status(400).json({ message: "Invalid event ID" });
      }

      const event = await eventCollection.findOne({
        _id: new ObjectId(eventId),
      });
      if (!event) return res.status(404).json({ message: "Event not found" });

      const registration = await registrationCollection.insertOne({
        eventId: new ObjectId(eventId),
        clubId: event.clubId,
        userEmail,
        status: "registered",
        paymentId: paymentId || null,
        registeredAt: new Date(),
      });

      res
        .status(201)
        .json({ message: "Registered successfully", registration });
    });

    //payment
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      let query = {};

      if (email) {
        query.userEmail = email;
      }

      const result = await paymentCollection.find(query).toArray();
      res.send(result);
    });
    //stripe
    app.post("/create-checkout-session", async (req, res) => {
      const { clubId, clubName, membershipFee, userEmail } = req.body;

      const amount = parseInt(membershipFee) * 100; // stripe শুধু cents নেয়

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: `${clubName} Membership Fee`,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",

        metadata: {
          clubId,
          clubName,
          userEmail,
        },

        customer_email: userEmail,

        success_url: `${process.env.CLIENT_URL}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/dashboard/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    //paymentsuccess
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;

      if (!sessionId) {
        return res.status(400).send({ error: "Missing session_id" });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (!session || !session.metadata) {
        return res.status(400).send({ error: "Invalid session data" });
      }

      // Payment MUST be paid
      if (session.payment_status !== "paid") {
        return res.send({ success: false });
      }

      const transactionId = session.payment_intent;

      // Prevent duplicate payments
      const existing = await paymentCollection.findOne({ transactionId });
      if (existing) {
        return res.send({
          success: true,
          message: "Payment already processed",
          transactionId,
        });
      }

      // Extract data
      const { clubId, clubName, userEmail } = session.metadata;

      // Create membership record
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

      // Save to payments collection
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

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("My clubsphere going onnnnnnnnn..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
