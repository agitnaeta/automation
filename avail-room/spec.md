🎯 User Story
As an internal team member (Property Manager, Sales, Customer Service)
I want to ask the chatbot about villa availability via WhatsApp
So that I can quickly check which villas are available without logging into Guesty
📝 Description
Add a new chatbot feature that allows internal users to query villa availability directly through WhatsApp by connecting to the Guesty API.
What It Does:
Users can ask natural language questions about villa availability, and the chatbot will:
Parse the query (date range, bedroom type)
Call Guesty API to check availability
Return a list of available villas with prices
🔧 Requirements
Functional Requirements:
Query Types Supported:
By Date Range: "Available villas March 15-20?"
By Bedroom Type: "Available 2BR villas next week?"
Combined: "Available 3BR villas April 1-7?"
Response Must Include:
Villa name
Available date range
Price per night (IDR)
Bedroom type
Location (Canggu/Bingin)
💬 Example Conversations
Example 1: Date Range Query

User: "What villas are available March 15-20?"
Bot: Available Villas (Mar 15-20, 2026)
5 nights total
2BR Villas (8 available):

- Villa Vos (Canggu)
  IDR 2,940,000/night
- Villa Alua (Bingin)
  IDR 2,750,000/night
- Villa Sirocco (Bingin)
  IDR 2,750,000/night
  [Show all 8] [Book Villa]
  Example 2: Bedroom Type Filter

User: "Available 3BR villas next week?"
Bot: Available 3BR Villas (Mar 17-24)
7 nights
3BR Villas (2 available):

- Villa Kamaya Bingin (Bingin)
  IDR 3,000,000/night
  Total: IDR 21,000,000
- Villa Navara (Bingin)
  IDR 3,250,000/night
  Total: IDR 22,750,000
  [Villa Details] [Check Availability]
  Example 3: Combined Query

User: "Show me 2BR villas in Canggu April 1-7"
Bot: Available 2BR Villas - Canggu (Apr 1-7)
6 nights
Icons Canggu (4 available):

- Villa Vos
  IDR 3,440,000/night (shoulder season)
  Total: IDR 20,640,000
- Villa Familia
  IDR 3,440,000/night
  Total: IDR 20,640,000
- Villa Noe Linda
  IDR 3,440,000/night
  Total: IDR 20,640,000
- Villa Uma Asmara
  IDR 3,440,000/night
  Total: IDR 20,640,000
  [Book Now] [Calendar View]
  Example 4: No Availability

User: "Any 4BR available this weekend?"
Bot: No 4BR Villas Available
Weekend: Mar 15-17
All 4BR villas fully booked:

- Villa Ulana (Bingin)
- Villa Palma 1-2 (Connecting)
- Villa Serene Senja I (Connecting)
  💡 Alternative options:
- 3BR villas: 2 available
- Next available 4BR: Mar 22
  [View Alternatives] [Set Alert]
