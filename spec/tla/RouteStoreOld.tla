---------------- MODULE RouteStoreOld ----------------
\* Bounded model of the old allocation and age-only lock.
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Proc, Ports, NoProc, NoPort
ASSUME /\ NoProc \notin Proc /\ NoPort \notin Ports
VARIABLES alive, bound, routes, candidate, owner, old, cs
vars == <<alive, bound, routes, candidate, owner, old, cs>>
Init ==
  /\ alive = Proc /\ bound = [p \in Proc |-> NoPort] /\ routes = {}
  /\ candidate = [p \in Proc |-> NoPort] /\ owner = NoProc /\ old = FALSE /\ cs = {}
Probe(p, port) ==
  /\ p \in alive /\ candidate[p] = NoPort /\ port \in Ports /\ port \notin {bound[q] : q \in Proc}
  /\ candidate' = [candidate EXCEPT ![p] = port]
  /\ UNCHANGED <<alive, bound, routes, owner, old, cs>>
Acquire(p) ==
  /\ p \in alive /\ p \notin cs /\ (owner = NoProc \/ old)
  /\ owner' = p /\ old' = FALSE /\ cs' = cs \cup {p}
  /\ UNCHANGED <<alive, bound, routes, candidate>>
Age == /\ owner \in Proc /\ ~old /\ old' = TRUE
  /\ UNCHANGED <<alive, bound, routes, candidate, owner, cs>>
Save(p) ==
  /\ p \in alive /\ p \in cs /\ candidate[p] \in Ports
  /\ routes' = {r \in routes : r.host # p} \cup {[host |-> p, pid |-> p, port |-> candidate[p]]}
  /\ candidate' = [candidate EXCEPT ![p] = NoPort]
  /\ UNCHANGED <<alive, bound, owner, old, cs>>
Release(p) ==
  /\ p \in alive /\ p \in cs
  /\ owner' = NoProc /\ old' = FALSE /\ cs' = cs \ {p}
  /\ UNCHANGED <<alive, bound, routes, candidate>>
Crash(p) ==
  /\ p \in alive /\ alive' = alive \ {p} /\ cs' = cs \ {p}
  /\ bound' = [bound EXCEPT ![p] = NoPort]
  /\ UNCHANGED <<routes, candidate, owner, old>>
Bind(p, port) ==
  /\ p \in alive /\ bound[p] = NoPort /\ port \in Ports /\ port \notin {bound[q] : q \in Proc}
  /\ \E r \in routes : r.pid = p /\ r.port = port
  /\ bound' = [bound EXCEPT ![p] = port]
  /\ UNCHANGED <<alive, routes, candidate, owner, old, cs>>
Next ==
  \/ \E p \in Proc, port \in Ports : Probe(p, port) \/ Bind(p, port)
  \/ \E p \in Proc : Acquire(p) \/ Save(p) \/ Release(p) \/ Crash(p)
  \/ Age
UniqueLivePorts == \A r, s \in routes :
  (r.pid \in alive /\ s.pid \in alive /\ r.pid # s.pid) => r.port # s.port
LockExclusion == Cardinality(cs) <= 1
Spec == Init /\ [][Next]_vars
============================================================
