---------------- MODULE RouteStore ----------------
\* Bounded reservation and owner-aware lock model.
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Proc, Ports, NoProc, NoPort, ReclaimRace
ASSUME /\ NoProc \notin Proc /\ NoPort \notin Ports /\ 0 \notin Proc
VARIABLES alive, dead, bound, routes, candidate, lockExists, owner, creator, old, cs, pending
vars == <<alive, dead, bound, routes, candidate, lockExists, owner, creator, old, cs, pending>>
Live(r) == r.pid = 0 \/ r.pid \in alive
Reserved(port) == \E r \in routes : r.port = port /\ Live(r)
Init ==
  /\ alive = Proc /\ dead = {} /\ bound = [p \in Proc |-> NoPort] /\ routes = {}
  /\ candidate = [p \in Proc |-> NoPort] /\ lockExists = FALSE
  /\ owner = NoProc /\ creator = NoProc /\ old = FALSE /\ cs = {} /\ pending = {}
Probe(p, port) ==
  /\ p \in alive /\ p \notin cs /\ ( ~lockExists \/ creator # p)
  /\ candidate[p] = NoPort /\ port \in Ports /\ port \notin {bound[q] : q \in Proc}
  /\ candidate' = [candidate EXCEPT ![p] = port]
  /\ UNCHANGED <<alive, dead, bound, routes, lockExists, owner, creator, old, cs, pending>>
Mkdir(p) ==
  /\ p \in alive /\ p \notin cs /\ ~lockExists
  /\ lockExists' = TRUE /\ owner' = NoProc /\ creator' = p /\ old' = FALSE
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, cs, pending>>
WriteOwner(p) ==
  /\ p \in alive /\ lockExists /\ creator = p /\ owner = NoProc
  /\ owner' = p /\ cs' = cs \cup {p}
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, lockExists, creator, old, pending>>
Register(p) ==
  /\ p \in alive /\ p \in cs /\ candidate[p] \in Ports
  /\ IF Reserved(candidate[p])
       THEN /\ candidate' = [candidate EXCEPT ![p] = NoPort]
            /\ UNCHANGED routes
       ELSE /\ routes' = {r \in routes : r.host # p \/ ~Live(r)}
                         \cup {[host |-> p, pid |-> p, port |-> candidate[p]]}
            /\ candidate' = [candidate EXCEPT ![p] = NoPort]
  /\ UNCHANGED <<alive, dead, bound, lockExists, owner, creator, old, cs, pending>>
Release(p) ==
  /\ p \in alive /\ p \in cs
  /\ lockExists' = FALSE /\ owner' = NoProc /\ creator' = NoProc /\ old' = FALSE /\ cs' = cs \ {p}
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, pending>>
Age == /\ lockExists /\ ~old /\ old' = TRUE
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, lockExists, owner, creator, cs, pending>>
Eligible == lockExists /\ old /\ (owner = NoProc \/ owner \notin alive)
Reclaim ==
  /\ Eligible /\ lockExists' = FALSE /\ owner' = NoProc /\ creator' = NoProc /\ old' = FALSE
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, cs, pending>>
ReadReclaim(p) ==
  /\ p \in alive /\ p \notin cs /\ p # creator /\ Eligible /\ owner \in dead /\ p \notin pending
  /\ pending' = pending \cup {p}
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, lockExists, owner, creator, old, cs>>
RemoveReclaim(p) ==
  /\ p \in alive /\ p \in pending /\ lockExists
  /\ pending' = pending \ {p} /\ lockExists' = FALSE /\ owner' = NoProc /\ creator' = NoProc /\ old' = FALSE
  /\ UNCHANGED <<alive, dead, bound, routes, candidate, cs>>
Crash(p) ==
  /\ p \in alive /\ alive' = alive \ {p} /\ dead' = dead \cup {p} /\ cs' = cs \ {p}
  /\ bound' = [bound EXCEPT ![p] = NoPort]
  /\ UNCHANGED <<routes, candidate, lockExists, owner, creator, old, pending>>
Bind(p, port) ==
  /\ p \in alive /\ bound[p] = NoPort /\ port \in Ports /\ port \notin {bound[q] : q \in Proc}
  /\ \E r \in routes : r.pid = p /\ r.port = port
  /\ bound' = [bound EXCEPT ![p] = port]
  /\ UNCHANGED <<alive, dead, routes, candidate, lockExists, owner, creator, old, cs, pending>>
Remove(p) ==
  /\ p \in alive /\ ~lockExists /\ \E r \in routes : r.pid = p
  /\ routes' = {r \in routes : r.pid # p}
  /\ UNCHANGED <<alive, dead, bound, candidate, lockExists, owner, creator, old, cs, pending>>
Alias(p, port) ==
  /\ p \in Proc /\ port \in Ports /\ ~lockExists
  /\ ~\E r \in routes : r.host = <<"alias", p>>
  /\ routes' = routes \cup {[host |-> <<"alias", p>>, pid |-> 0, port |-> port]}
  /\ UNCHANGED <<alive, dead, bound, candidate, lockExists, owner, creator, old, cs, pending>>
Next ==
  \/ \E p \in Proc : Mkdir(p) \/ WriteOwner(p) \/ Release(p) \/ Crash(p)
  \/ Age
  \/ IF ReclaimRace THEN \E p \in Proc : ReadReclaim(p) \/ RemoveReclaim(p) ELSE Reclaim
  \/ ~ReclaimRace /\ (\E p \in Proc, port \in Ports : Probe(p, port) \/ Bind(p, port) \/ Alias(p, port))
  \/ ~ReclaimRace /\ (\E p \in Proc : Register(p) \/ Remove(p))
UniqueLivePorts == \A r, s \in routes :
  (r.pid \in alive /\ s.pid \in alive /\ r.pid # s.pid) => r.port # s.port
LockExclusion == Cardinality(cs) <= 1
NoWedge == Eligible => ENABLED Reclaim
NoPidReuse == alive \cap dead = {}
Spec == Init /\ [][Next]_vars
============================================================
