# LinkedIn: the decision, and what I would do

**For:** the owner of this system, who has to decide whether we build LinkedIn scraping or
messaging. Written because "the LinkedIn decision is yours" is not useful without the material to
make it.

**Where I land:** don't build it. Build the two compliant alternatives instead, which get most of
the value and none of the exposure. The reasoning is below; the decision is yours and if you
choose otherwise I will build what you ask for.

---

## What "LinkedIn" could mean here, because the options are not equally bad

Four distinct things get called "LinkedIn lead generation", and they carry very different risk.

### 1. Scraping profiles or search results from linkedin.com

Automated collection from LinkedIn pages, logged in or not.

- **Contract.** LinkedIn's User Agreement prohibits scraping, automated access, and the use of
  bots or scrapers. Doing it with a logged-in account is a breach of an agreement *you personally
  accepted*.
- **Enforcement is real and routine.** LinkedIn detects automation and restricts or permanently
  bans accounts. It also litigates — the *hiQ* line of cases is often cited as though it
  established a right to scrape; it did not. It concerned the Computer Fraud and Abuse Act and
  public pages, the CFAA claim's failure did not dispose of the breach-of-contract claim, and hiQ
  ultimately lost on that. Anyone telling you "scraping public LinkedIn is legal, *hiQ* said so"
  has read a headline.
- **Data protection.** A LinkedIn profile is richer than a contact page: career history, education,
  connections, sometimes inferences about seniority and tenure. That is more personal data about
  an identified individual, obtained without their knowledge, and it makes the balancing test in
  any legitimate interests assessment materially harder — you are no longer collecting a published
  business address, you are building a profile.
- **What you would actually lose.** The account that gets banned is usually a real person's, and
  often the founder's. That is a working relationship network, not just a login.

### 2. Automated connection requests or InMail

Same User Agreement problem, plus the message itself is now electronic direct marketing and every
rule in `legal-review-pack.md` applies to it — in Germany it needs prior consent like any other
advertising message, and there is no PECR carve-out that makes LinkedIn special.

The system already has a flag for this (`REAL_LINKEDIN_SEND_ENABLED`, off) and no implementation
behind it, which is the honest state.

### 3. Sales Navigator export

Paid, and within LinkedIn's own product. Exporting to CSV is a supported feature in some tiers and
a licence question in others — worth checking your contract rather than assuming. **If it is
available on your licence, this is the good option:** the records come out through a front door,
and the CSV importer that already exists ingests them, validates them, records the source as
`IMPORT`, and puts them through the same Article 14 notice as everything else.

Note that "LinkedIn said this person is a Practice Manager" is data, not authority — the system
treats it as such, and a provider's or platform's opinion that a record is "verified" is not read
as consent by anything in this codebase.

### 4. A person, reading LinkedIn, typing what they found

Not scraping. A human using a website as a human, and recording the result. Slow, and entirely
unobjectionable. The manual-entry path already exists and records the origin.

---

## What we built instead, and how close it gets

The scraper that ships reads **company websites**, not LinkedIn. That is a materially different
proposition:

- most company sites have no term prohibiting it, and the crawler checks `robots.txt` on every
  run and obeys it, treating an unreachable robots file as a refusal rather than permission;
- it identifies itself (`AbedinGrowthBot`) rather than pretending to be a browser;
- it rate-limits itself and honours crawl-delay;
- it collects a contact address and company facts — not a career history;
- every URL is resolved and checked before the request, so it cannot be steered into an internal
  network.

For the audience this system is actually aimed at — UK dental and healthcare practices — the
practice website is usually a *better* source than LinkedIn anyway. The practice manager's address
is on the contact page; the decision-maker at a six-person practice is not hiding behind a
corporate directory.

Where the website route is genuinely worse is enterprise prospecting: finding the right one of
four hundred people at a large company. If that becomes the business, the answer is a paid data
provider through the discovery adapter, not a scraper pointed at LinkedIn.

---

## The decision, in the form it needs to be made

**Option A — don't build it.** Use Sales Navigator export where your licence allows, manual entry
otherwise, and the website scraper for volume. No ToS exposure, no account risk, and the
legitimate interests assessment stays defensible.

**Option B — build the Sales Navigator export path properly.** A day's work at most: a column
mapping preset for the Navigator CSV format so an export drops straight in. Front door, no
automation against LinkedIn, no new risk. *This is the one I would actually build if you want more
LinkedIn-sourced volume.*

**Option C — build profile scraping.** I will build it if you decide to, and I will build it
carefully — but I would want the decision recorded, because the risks land on you and not on the
code: a breach of an agreement you accepted personally, a real chance of losing the account, and
an assessment that gets harder to defend because the data is richer. I would also want to know
what you want the system to do when LinkedIn blocks it, which it will.

**Option D — automated messaging.** I would push back on this one hardest. It is the ToS problem
*plus* the full weight of the marketing rules, on a channel where the recipient has no unsubscribe
mechanism we control. If you want it anyway, say so and we will talk about how to do it least
badly.

---

## What I need from you

One line: A, B, C or D. If B, I will build the Navigator preset next. If C or D, tell me and I
will build it — I would like the instruction in writing, not because I am covering myself, but
because a decision with this shape should exist somewhere other than a conversation.
