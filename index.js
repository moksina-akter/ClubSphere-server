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
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
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
    const registrationCollection = db.collection("eventRegistrations");

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
