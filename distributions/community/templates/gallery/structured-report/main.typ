#set document(
  title: "Structured Report",
  author: "Your team",
)
#set page(paper: "us-letter", margin: (x: 1in, y: 0.85in))
#set text(size: 10.5pt)
#set heading(numbering: "1.")

#align(center)[
  #text(22pt, weight: "bold")[Structured Report]
  #v(0.35em)
  #text(fill: luma(90))[Prepared by your team · #datetime.today().display()]
]

#v(1fr)
#outline(title: [Contents])
#v(1fr)

#pagebreak()

= Executive summary

Summarize the decision, the supporting evidence, and the requested action.

= Context

Explain the problem and the constraints that shape the work.

== Key result

#figure(
  rect(
    width: 100%,
    height: 2.2in,
    radius: 6pt,
    fill: rgb("e9eefc"),
    stroke: rgb("b7c4ef"),
    align(center + horizon)[Replace with a chart or diagram],
  ),
  caption: [A concise caption explains why the result matters.],
)

= Recommendation

- State the recommendation.
- Name the owner and expected outcome.
- Record risks and follow-up work.
